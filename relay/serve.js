import { handle, parseRequest, DEFAULT_TIERS } from './core.js';
import { semanticEval } from './semantic-eval.js';
import { MODELS } from './models.js';

const MAX_BODY = 2048;
const PROBE_TTL_MS = 300000;
const JSON_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };

// The scheduled keep-warm event (EventBridge) only needs the container initialised, not a response.
export const isWarmEvent = (event) => event?.warm === true;

function reply(sink, status, obj) {
  sink.head(status, JSON_HEADERS);
  sink.write(JSON.stringify(obj));
  return sink.end();
}

// Asks the model one tiny question so the page can tell "the relay is up" from "the model will answer".
// The result is cached for five minutes per container and concurrent callers share one call, so a page that
// is opened many times still costs at most one five-token request per five minutes. Only the error name and a
// short message are returned, never a stack or anything from the request.
export function probeModel(deps) {
  const ttl = deps.probeTtlMs ?? PROBE_TTL_MS;
  const now = Date.now();
  if (deps.probe && now - deps.probe.at < ttl) return deps.probe.promise;
  const tiers = deps.tiers ?? DEFAULT_TIERS;
  const promise = (async () => {
    try {
      for await (const ev of deps.provider.stream({ modelId: MODELS[tiers.fast].id, system: 'You are a concise assistant.', question: 'Reply with the single word: ok', maxTokens: 5, cachePoint: false })) {
        if (ev.type === 'text') return { ok: true, model: tiers.fast };
      }
      return { ok: false, name: 'NoAnswer', message: 'the model returned no text' };
    } catch (e) {
      return { ok: false, name: e?.name ?? 'Error', message: String(e?.message ?? e).slice(0, 160) };
    }
  })();
  deps.probe = { at: now, promise };
  return promise;
}

function serveGet(path, sink, deps) {
  if (path === '/health') return reply(sink, 200, { ok: true, region: deps.region, provider: deps.provider.name });
  if (path === '/health/model') return probeModel(deps).then((r) => reply(sink, 200, r));
  if (path === '/semantic-eval.json') return reply(sink, 200, semanticEval(deps.workload));
  if (path === '/prompts.json') {
    return reply(sink, 200, [...deps.workload.prompts.values()].map(({ id, stratum, question }) => ({ id, stratum, question })));
  }
  const asset = deps.web?.get(path === '/' ? '/index.html' : path);
  if (!asset) return reply(sink, 404, { t: 'error', code: 'not_found' });
  sink.head(200, asset.headers);
  sink.write(asset.body);
  return sink.end();
}

// Transport-agnostic request handler. `sink` is {head(status, headers), write(str), end()}, implemented by
// the Lambda stream (handler.js) and by node:http (local.js), so tests exercise the real logic.
export async function serve({ method, path = '/', rawBody = '' }, sink, deps) {
  if (method === 'GET') return serveGet(path, sink, deps);
  if (method !== 'POST') return reply(sink, 405, { t: 'error', code: 'method_not_allowed' });
  if (Buffer.byteLength(rawBody) > MAX_BODY) return reply(sink, 413, { t: 'error', code: 'too_large' });
  const parsed = parseRequest(rawBody, deps.workload, { budgetMs: deps.budgetMs });
  if (!parsed.ok) return reply(sink, parsed.status, { t: 'error', code: 'bad_request', message: parsed.message });

  sink.head(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
  const { stream } = parsed.value;
  const held = [];
  for await (const ev of handle(parsed.value, deps)) {
    const line = JSON.stringify(ev) + '\n';
    if (stream) { sink.write(line); continue; }
    // stream:false is the classic non-streaming baseline: hold everything, release it once the answer is complete.
    held.push(line);
    if (ev.t === 'done' || ev.t === 'error') { sink.write(held.join('')); held.length = 0; }
  }
  return sink.end();
}
