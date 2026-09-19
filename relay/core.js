import { MODELS } from './models.js';
import { cacheKey, normalize } from './cache.js';

export const MAX_TOKENS = 300;
const SAFE = /^[A-Za-z0-9_-]{0,40}$/;
const bad = (status, message) => ({ ok: false, status, message });

// Validates a public request. Only fixed workload prompts and allowlisted models are accepted, so the
// endpoint cannot be used as a free general-purpose model proxy.
export function parseRequest(raw, workload) {
  let b;
  try { b = JSON.parse(raw); } catch { return bad(400, 'body must be JSON'); }
  if (!b || typeof b !== 'object' || Array.isArray(b)) return bad(400, 'body must be a JSON object');
  const prompt = workload.prompts.get(b.promptId);
  if (!prompt) return bad(404, 'unknown promptId');
  const model = Object.hasOwn(MODELS, b.model) ? MODELS[b.model] : null;
  if (!model) return bad(400, 'unknown model');
  const flag = (k, d) => (b[k] === undefined ? d : b[k]);
  const stream = flag('stream', true), responseCache = flag('responseCache', false), promptCache = flag('promptCache', false);
  if ([stream, responseCache, promptCache].some((v) => typeof v !== 'boolean')) return bad(400, 'stream, responseCache and promptCache must be booleans');
  if (promptCache && model.cache !== 'explicit') return bad(400, `model ${b.model} does not support an explicit prompt cache`);
  const prefixSalt = b.prefixSalt ?? '', namespace = b.namespace ?? 'default';
  if (![prefixSalt, namespace].every((v) => typeof v === 'string' && SAFE.test(v))) return bad(400, 'prefixSalt and namespace must match [A-Za-z0-9_-]{0,40}');
  const maxTokens = b.maxTokens ?? 200;
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > MAX_TOKENS) return bad(400, `maxTokens must be an integer from 1 to ${MAX_TOKENS}`);
  return { ok: true, value: { prompt, modelHandle: b.model, model, stream, responseCache, promptCache, prefixSalt, namespace, maxTokens } };
}

// The salt goes first so a changed salt invalidates any cached prefix. The benchmark uses a fresh salt per
// request for "cold prefix" arms, which is what keeps the control arm honest against implicit caching.
export function buildSystem(workload, prompt, prefixSalt) {
  const salt = prefixSalt ? `[run ${prefixSalt}]\n` : '';
  return prompt.handbook
    ? `${salt}Answer using only the handbook below. Be concise.\n\n${workload.handbook}`
    : `${salt}You are a concise assistant.`;
}

const zeroUsage = (u = {}) => ({
  inputTokens: u.inputTokens ?? 0, outputTokens: u.outputTokens ?? 0,
  cacheReadInputTokens: u.cacheReadInputTokens ?? 0, cacheWriteInputTokens: u.cacheWriteInputTokens ?? 0,
});

// Yields the event stream for one request: accepted, token*, then done or error.
export async function* handle(req, deps) {
  const { provider, cache, workload, region, clock = () => performance.now() } = deps;
  const t0 = clock();
  yield { t: 'accepted', region, model: req.modelHandle, stream: req.stream };

  const key = req.responseCache
    ? cacheKey({ v: 1, q: normalize(req.prompt.question), m: req.model.id, n: req.maxTokens, h: workload.handbookVersion, ns: req.namespace, hb: req.prompt.handbook })
    : null;
  let cacheState = 'off';
  if (key) {
    cacheState = 'miss';
    let hit = null;
    try { hit = await cache.get(key); } catch (e) { cacheState = 'error'; console.error('cache get failed', e?.name); }
    if (hit) {
      const first = clock() - t0;
      yield { t: 'token', text: hit.text };
      yield {
        t: 'done', route: 'response-cache', cache: 'hit', model: req.modelHandle, provider: hit.provider, region,
        usage: hit.usage, stopReason: 'cached', srv: { first_token_ms: first, total_ms: clock() - t0 },
      };
      return;
    }
  }

  const tSend = clock();
  let firstUp = null, firstReasoning = null, usage = zeroUsage(), upstreamLatency = null, stopReason = null, text = '';
  try {
    for await (const ev of provider.stream({
      modelId: req.model.id, system: buildSystem(workload, req.prompt, req.prefixSalt),
      question: req.prompt.question, maxTokens: req.maxTokens, cachePoint: req.promptCache, extra: req.model.extra,
    })) {
      if (ev.type === 'reasoning') {
        // Reasoning content is not forwarded, only noted: it means the first answer token came after thinking.
        firstReasoning ??= clock();
      } else if (ev.type === 'text') {
        if (firstUp === null) firstUp = clock();
        text += ev.text;
        yield { t: 'token', text: ev.text };
      } else if (ev.type === 'usage') {
        usage = zeroUsage(ev.usage); upstreamLatency = ev.latencyMs ?? null; stopReason = ev.stopReason ?? null;
      }
    }
  } catch (e) {
    yield { t: 'error', code: 'upstream', name: e?.name ?? 'Error', message: String(e?.message ?? e).slice(0, 160), model: req.modelHandle, region };
    return;
  }
  const tEnd = clock();
  yield {
    t: 'done', route: 'model', cache: cacheState, model: req.modelHandle, provider: provider.name, region, usage, stopReason,
    reasoning: firstReasoning !== null,
    srv: {
      first_token_ms: firstUp === null ? null : firstUp - t0, upstream_ttft_ms: firstUp === null ? null : firstUp - tSend,
      first_reasoning_ms: firstReasoning === null ? null : firstReasoning - t0,
      upstream_latency_ms: upstreamLatency, total_ms: tEnd - t0,
    },
  };
  // After done, so the write does not delay the client's completion time; serve() drains the generator.
  if (key && text) {
    try { await cache.put(key, { text, usage, provider: provider.name }); } catch (e) { console.error('cache put failed', e?.name); }
  }
}
