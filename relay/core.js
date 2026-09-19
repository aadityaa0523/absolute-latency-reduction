import { MODELS } from './models.js';
import { cacheKey, normalize } from './cache.js';
import { canonical } from './canon.js';
import { route } from './router.js';
import { raceToFirstToken } from './hedge.js';

export const MAX_TOKENS = 300;
export const DEFAULT_TIERS = { fast: 'nova-lite-apac', strong: 'sonnet-5-global' };
const SAFE = /^[A-Za-z0-9_-]{0,40}$/;
const bad = (status, message) => ({ ok: false, status, message });

// Validates a public request. Only fixed workload prompts and allowlisted models are accepted, so the
// endpoint cannot be used as a free general-purpose model proxy.
// Two modes: manual (the caller names the model and each lever) and auto (the gateway routes, caches and falls back).
export function parseRequest(raw, workload, defaults = {}) {
  let b;
  try { b = JSON.parse(raw); } catch { return bad(400, 'body must be JSON'); }
  if (!b || typeof b !== 'object' || Array.isArray(b)) return bad(400, 'body must be a JSON object');
  const prompt = workload.prompts.get(b.promptId);
  if (!prompt) return bad(404, 'unknown promptId');
  const flag = (k, d) => (b[k] === undefined ? d : b[k]);
  const auto = flag('auto', false);
  const stream = flag('stream', true), responseCache = flag('responseCache', auto), semanticCache = flag('semanticCache', auto);
  const fallback = flag('fallback', auto), promptCache = flag('promptCache', false);
  if ([auto, stream, responseCache, semanticCache, fallback, promptCache].some((v) => typeof v !== 'boolean')) return bad(400, 'auto, stream, responseCache, semanticCache, fallback and promptCache must be booleans');
  if (fallback && !auto) return bad(400, 'fallback needs auto mode');
  if (semanticCache && !responseCache) return bad(400, 'semanticCache needs responseCache');
  const model = auto ? null : Object.hasOwn(MODELS, b.model) ? MODELS[b.model] : null;
  if (!auto && !model) return bad(400, 'unknown model');
  if (promptCache && !auto && model.cache !== 'explicit') return bad(400, `model ${b.model} does not support an explicit prompt cache`);
  const prefixSalt = b.prefixSalt ?? '', namespace = b.namespace ?? 'default';
  if (![prefixSalt, namespace].every((v) => typeof v === 'string' && SAFE.test(v))) return bad(400, 'prefixSalt and namespace must match [A-Za-z0-9_-]{0,40}');
  const maxTokens = b.maxTokens ?? 200;
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > MAX_TOKENS) return bad(400, `maxTokens must be an integer from 1 to ${MAX_TOKENS}`);
  const budgetMs = b.budgetMs ?? defaults.budgetMs ?? 2500;
  if (!Number.isInteger(budgetMs) || budgetMs < 200 || budgetMs > 10000) return bad(400, 'budgetMs must be an integer from 200 to 10000');
  return { ok: true, value: { prompt, auto, modelHandle: auto ? null : b.model, model, stream, responseCache, semanticCache, fallback, promptCache, prefixSalt, namespace, maxTokens, budgetMs } };
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
// done.trace says why the answer was fast or slow: which cache or model served it, and whether the fallback fired.
export async function* handle(req, deps) {
  const { provider, cache, workload, region, clock = () => performance.now(), tiers = DEFAULT_TIERS } = deps;
  const t0 = clock();
  yield { t: 'accepted', region, model: req.modelHandle, stream: req.stream, auto: req.auto };

  const routing = req.auto ? route(req.prompt) : null;
  const primary = req.auto ? tiers[routing.tier] : req.modelHandle;
  if (!MODELS[primary]) {
    yield { t: 'error', code: 'misconfigured', message: `tier model ${primary} is not allowlisted`, region };
    return;
  }
  const trace = { mode: req.auto ? 'auto' : 'manual', tier: routing?.tier ?? null, reasons: routing?.reasons ?? [] };

  const q = req.prompt.question;
  const scope = { v: 1, n: req.maxTokens, h: workload.handbookVersion, ns: req.namespace, hb: req.prompt.handbook, scope: req.auto ? 'auto' : MODELS[primary].id };
  const exactKey = req.responseCache ? cacheKey({ ...scope, q: normalize(q) }) : null;
  const canon = canonical(q);
  const semKey = req.semanticCache && canon ? cacheKey({ ...scope, sem: canon }) : null;
  let cacheState = req.responseCache ? 'miss' : 'off';
  if (exactKey) {
    let hit = null, source = null;
    try {
      hit = await cache.get(exactKey); source = 'exact';
      // Verified: the stored canonical form must equal ours, so a key collision or a lexicon change can never serve a wrong answer.
      if (!hit && semKey) { const s = await cache.get(semKey); if (s && s.canon === canon) { hit = s; source = 'semantic'; } }
    } catch (e) { cacheState = 'error'; console.error('cache get failed', e?.name); hit = null; }
    if (hit) {
      const first = clock() - t0;
      yield { t: 'token', text: hit.text };
      yield {
        t: 'done', route: 'response-cache', cache: 'hit', model: hit.model ?? req.modelHandle, provider: hit.provider, region,
        usage: hit.usage, stopReason: 'cached', reasoning: false,
        trace: { ...trace, source, ...(source === 'semantic' ? { matched: hit.question } : {}) },
        srv: { first_token_ms: first, total_ms: clock() - t0 },
      };
      return;
    }
  }

  const tSend = clock();
  const fallbackHandle = req.auto && req.fallback && routing.tier === 'strong' ? tiers.fast : null;
  const system = buildSystem(workload, req.prompt, req.prefixSalt);
  const start = (handle, signal) => {
    const m = MODELS[handle];
    return provider.stream({
      modelId: m.id, system, question: q, maxTokens: req.maxTokens, signal, extra: m.extra, cacheTtl: m.cacheTtl,
      cachePoint: req.auto ? m.cache === 'explicit' && req.prompt.handbook : req.promptCache,
    });
  };
  let firstUp = null, firstReasoning = null, usage = zeroUsage(), upstreamLatency = null, stopReason = null, text = '';
  let winner = primary, fired = false, reason = null;
  try {
    for await (const ev of raceToFirstToken({ start, primary, fallback: fallbackHandle, budgetMs: req.budgetMs })) {
      if (ev.type === 'route') { winner = ev.winner; fired = ev.fired; reason = ev.reason; }
      else if (ev.type === 'reasoning') {
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
    yield { t: 'error', code: 'upstream', name: e?.name ?? 'Error', message: String(e?.message ?? e).slice(0, 160), model: winner, region };
    return;
  }
  const tEnd = clock();
  yield {
    t: 'done', route: 'model', cache: cacheState, model: winner, provider: provider.name, region, usage, stopReason,
    reasoning: firstReasoning !== null,
    trace: { ...trace, source: fired ? 'fallback' : 'primary', fallback: { armed: fallbackHandle !== null, fired, reason, budgetMs: req.budgetMs } },
    srv: {
      first_token_ms: firstUp === null ? null : firstUp - t0, upstream_ttft_ms: firstUp === null ? null : firstUp - tSend,
      first_reasoning_ms: firstReasoning === null ? null : firstReasoning - t0,
      upstream_latency_ms: upstreamLatency, total_ms: tEnd - t0,
    },
  };
  // After done, so the write does not delay the client's completion time; serve() drains the generator.
  if (exactKey && text) {
    const entry = { text, usage, provider: provider.name, question: q, model: winner };
    try {
      await cache.put(exactKey, entry);
      if (semKey) await cache.put(semKey, { ...entry, canon });
    } catch (e) { console.error('cache put failed', e?.name); }
  }
}
