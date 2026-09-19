import { handle, parseRequest } from './core.js';

const MAX_BODY = 2048;
const JSON_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store' };

function reply(sink, status, obj) {
  sink.head(status, JSON_HEADERS);
  sink.write(JSON.stringify(obj));
  return sink.end();
}

// Transport-agnostic request handler. `sink` is {head(status, headers), write(str), end()}, implemented by
// the Lambda stream (handler.js) and by node:http (local.js), so tests exercise the real logic.
export async function serve({ method, rawBody = '' }, sink, deps) {
  if (method === 'GET') return reply(sink, 200, { ok: true, region: deps.region, provider: deps.provider.name });
  if (method !== 'POST') return reply(sink, 405, { t: 'error', code: 'method_not_allowed' });
  if (Buffer.byteLength(rawBody) > MAX_BODY) return reply(sink, 413, { t: 'error', code: 'too_large' });
  const parsed = parseRequest(rawBody, deps.workload);
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
