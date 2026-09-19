import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRequest, handle, MAX_TOKENS } from '../relay/core.js';
import { serve } from '../relay/serve.js';
import { cacheKey, normalize, MemoryCache } from '../relay/cache.js';
import { mockProvider } from '../relay/providers/mock.js';
import { loadWorkload } from '../relay/workload.js';

const workload = await loadWorkload();
const req = (over = {}) => JSON.stringify({ promptId: 'h01', model: 'sonnet-5-global', ...over });
const deps = (over = {}) => ({ workload, region: 'test', provider: mockProvider({ ttftMs: 1, tokensPerSec: 1000, outTokens: 3 }), cache: new MemoryCache(), ...over });
const collect = async (raw, d) => { const p = parseRequest(raw, workload); assert.ok(p.ok, p.message); const evs = []; for await (const e of handle(p.value, d)) evs.push(e); return evs; };

test('the handbook is long enough for the prompt-cache minimum of the explicit-cache models', () => {
  // ~4 characters per token. Sonnet 5 needs 1,024 tokens; Haiku 4.5 needs 4,096 and is expected to fall short.
  assert.ok(workload.handbook.length / 4 > 1100, `handbook is only ~${Math.round(workload.handbook.length / 4)} tokens`);
});

test('parseRequest accepts a minimal request and applies defaults', () => {
  const p = parseRequest(req(), workload);
  assert.ok(p.ok);
  assert.equal(p.value.stream, true);
  assert.equal(p.value.responseCache, false);
  assert.equal(p.value.maxTokens, 200);
});

test('parseRequest rejects bad input with the right status', () => {
  const cases = [
    ['not json', 400], ['[]', 400], ['null', 400],
    [req({ promptId: 'nope' }), 404],
    [req({ model: 'gpt-anything' }), 400],
    [req({ model: '__proto__' }), 400], [req({ model: 'constructor' }), 400], [req({ model: 'toString' }), 400],
    [req({ stream: 'yes' }), 400], [req({ responseCache: 1 }), 400],
    [req({ promptCache: true, model: 'gpt-oss-20b-inregion' }), 400],
    [req({ maxTokens: MAX_TOKENS + 1 }), 400], [req({ maxTokens: 0 }), 400], [req({ maxTokens: 1.5 }), 400],
    [req({ prefixSalt: 'has space' }), 400], [req({ namespace: 'x'.repeat(41) }), 400],
  ];
  for (const [raw, status] of cases) {
    const p = parseRequest(raw, workload);
    assert.equal(p.ok, false, raw);
    assert.equal(p.status, status, raw);
  }
});

test('handle streams accepted, tokens, then done with usage and server timings', async () => {
  const evs = await collect(req(), deps());
  assert.deepEqual(evs.map((e) => e.t), ['accepted', 'token', 'token', 'token', 'done']);
  const done = evs.at(-1);
  assert.equal(done.route, 'model');
  assert.equal(done.provider, 'mock');
  assert.equal(done.cache, 'off');
  assert.equal(done.usage.outputTokens, 3);
  assert.ok(done.srv.first_token_ms >= 0 && done.srv.total_ms >= done.srv.first_token_ms);
});

test('response cache: first call misses and stores, second call is served from the cache', async () => {
  const d = deps();
  const first = await collect(req({ responseCache: true }), d);
  assert.equal(first.at(-1).cache, 'miss');
  const second = await collect(req({ responseCache: true }), d);
  assert.equal(second.at(-1).cache, 'hit');
  assert.equal(second.at(-1).route, 'response-cache');
  assert.equal(second.filter((e) => e.t === 'token').map((e) => e.text).join(''), first.filter((e) => e.t === 'token').map((e) => e.text).join(''));
});

test('response cache is isolated by namespace and by model', async () => {
  const d = deps();
  await collect(req({ responseCache: true, namespace: 'a' }), d);
  assert.equal((await collect(req({ responseCache: true, namespace: 'b' }), d)).at(-1).cache, 'miss');
  assert.equal((await collect(req({ responseCache: true, namespace: 'a', model: 'haiku-4-5-global' }), d)).at(-1).cache, 'miss');
  assert.equal((await collect(req({ responseCache: true, namespace: 'a' }), d)).at(-1).cache, 'hit');
});

test('a cache outage is treated as a miss, not a failure', async () => {
  const broken = { get: async () => { throw new Error('boom'); }, put: async () => { throw new Error('boom'); } };
  const evs = await collect(req({ responseCache: true }), deps({ cache: broken }));
  assert.equal(evs.at(-1).t, 'done');
  assert.equal(evs.at(-1).cache, 'error');
});

test('an upstream failure becomes one error event and is never cached', async () => {
  const failing = { name: 'mock', async *stream() { throw Object.assign(new Error('Your account is currently being verified. '.repeat(10)), { name: 'AccessDeniedException' }); } };
  const d = deps({ provider: failing });
  const evs = await collect(req({ responseCache: true }), d);
  assert.deepEqual(evs.map((e) => e.t), ['accepted', 'error']);
  assert.equal(evs[1].name, 'AccessDeniedException');
  assert.ok(evs[1].message.length <= 160);
  assert.equal(await d.cache.get(cacheKey({})), null);
});

test('prompt cache flag reaches the provider as a cache point, and the salt leads the prefix', async () => {
  const seen = [];
  const spy = { name: 'mock', async *stream(a) { seen.push(a); yield { type: 'usage', usage: {} }; } };
  await collect(req({ promptCache: true, prefixSalt: 'run7' }), deps({ provider: spy }));
  await collect(req(), deps({ provider: spy }));
  assert.equal(seen[0].cachePoint, true);
  assert.ok(seen[0].system.startsWith('[run run7]\n'));
  assert.equal(seen[1].cachePoint, false);
  assert.ok(!seen[1].system.startsWith('['));
});

test('model-specific request fields reach the provider: Sonnet 5 must have thinking turned off', async () => {
  const seen = [];
  const spy = { name: 'mock', async *stream(a) { seen.push(a); yield { type: 'usage', usage: {} }; } };
  await collect(req({ model: 'sonnet-5-global' }), deps({ provider: spy }));
  await collect(req({ model: 'nova-lite-apac' }), deps({ provider: spy }));
  assert.deepEqual(seen[0].extra, { thinking: { type: 'disabled' } });
  assert.equal(seen[1].extra, undefined);
});

test('a reasoning model is flagged on done, and its reasoning is never forwarded to the client', async () => {
  const evs = await collect(req(), deps({ provider: mockProvider({ ttftMs: 1, tokensPerSec: 1000, outTokens: 2, reasoning: true }) }));
  const done = evs.at(-1);
  assert.equal(done.reasoning, true);
  assert.ok(done.srv.first_reasoning_ms >= 0);
  assert.deepEqual(evs.map((e) => e.t), ['accepted', 'token', 'token', 'done']);
  const plain = await collect(req(), deps());
  assert.equal(plain.at(-1).reasoning, false);
});

test('every allowlisted model has an id, and explicit-cache models state their minimum prefix', async () => {
  const { MODELS } = await import('../relay/models.js');
  for (const [handle, m] of Object.entries(MODELS)) {
    assert.match(m.id, /^[a-z0-9.-]+\.[A-Za-z0-9.:_-]+$/, handle);
    assert.ok(['explicit', 'none'].includes(m.cache), handle);
    if (m.cache === 'explicit') assert.ok(m.minCacheTokens >= 512, `${handle} needs minCacheTokens`);
  }
});

test('cacheKey ignores whitespace but changes with anything that can change the answer', () => {
  assert.equal(normalize('  a \n b\t'), 'a b');
  const base = { q: 'x', m: 'm1', n: 200, ns: 'a' };
  const k = cacheKey(base);
  assert.equal(cacheKey({ ...base }), k);
  for (const change of [{ q: 'y' }, { m: 'm2' }, { n: 201 }, { ns: 'b' }]) assert.notEqual(cacheKey({ ...base, ...change }), k);
});

function fakeSink() {
  const log = [];
  return { log, head: (status) => log.push({ head: status }), write: (s) => log.push({ write: s }), end: () => log.push({ end: true }) };
}

test('serve: streaming mode writes one line at a time, buffered mode releases everything in a single write', async () => {
  const streamed = fakeSink(), buffered = fakeSink();
  await serve({ method: 'POST', rawBody: req({ stream: true }) }, streamed, deps());
  await serve({ method: 'POST', rawBody: req({ stream: false }) }, buffered, deps());
  const writes = (s) => s.log.filter((x) => 'write' in x);
  assert.equal(writes(streamed).length, 5); // accepted, 3 tokens, done
  assert.equal(writes(buffered).length, 1);
  assert.equal(writes(buffered)[0].write.trim().split('\n').length, 5);
  assert.ok(streamed.log.at(-1).end && buffered.log.at(-1).end);
});

test('serve: health check, method and size guards', async () => {
  const s1 = fakeSink(); await serve({ method: 'GET', path: '/health' }, s1, deps());
  assert.equal(s1.log[0].head, 200);
  assert.equal(JSON.parse(s1.log[1].write).ok, true);
  const s2 = fakeSink(); await serve({ method: 'PUT', rawBody: '' }, s2, deps());
  assert.equal(s2.log[0].head, 405);
  const s3 = fakeSink(); await serve({ method: 'POST', rawBody: 'x'.repeat(3000) }, s3, deps());
  assert.equal(s3.log[0].head, 413);
  const s4 = fakeSink(); await serve({ method: 'POST', rawBody: req({ promptId: 'zzz' }) }, s4, deps());
  assert.equal(s4.log[0].head, 404);
});
