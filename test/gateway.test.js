import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRequest, handle } from '../relay/core.js';
import { raceToFirstToken } from '../relay/hedge.js';
import { route } from '../relay/router.js';
import { MemoryCache } from '../relay/cache.js';
import { mockProvider } from '../relay/providers/mock.js';
import { loadWorkload } from '../relay/workload.js';
import { MODELS } from '../relay/models.js';
import { isWarmEvent } from '../relay/serve.js';

const workload = await loadWorkload();
const tiers = { fast: 'nova-lite-apac', strong: 'sonnet-5-global' };
const FAST = MODELS['nova-lite-apac'].id, STRONG = MODELS['sonnet-5-global'].id;
const quick = (o = {}) => mockProvider({ ttftMs: 2, tokensPerSec: 2000, outTokens: 3, ...o });
const deps = (o = {}) => ({ workload, region: 'test', provider: quick(), cache: new MemoryCache(), tiers, ...o });
const body = (over = {}) => JSON.stringify({ promptId: 'h01', auto: true, ...over });
const collect = async (raw, d) => { const p = parseRequest(raw, workload); assert.ok(p.ok, p.message); const evs = []; for await (const e of handle(p.value, d)) evs.push(e); return evs; };
const done = (evs) => evs.at(-1);

test('auto mode defaults to caches on and fallback armed, and ignores a model handle', () => {
  const p = parseRequest(body({ model: 'anything' }), workload);
  assert.ok(p.ok);
  assert.deepEqual([p.value.responseCache, p.value.semanticCache, p.value.fallback, p.value.model], [true, true, true, null]);
  assert.equal(p.value.budgetMs, 2500);
});

test('the fallback and semantic cache need the modes they depend on, and the budget is bounded', () => {
  const bad = [
    [JSON.stringify({ promptId: 'h01', model: 'sonnet-5-global', fallback: true }), 400],
    [body({ responseCache: false, semanticCache: true }), 400],
    [body({ budgetMs: 199 }), 400], [body({ budgetMs: 10001 }), 400], [body({ budgetMs: 1.5 }), 400],
    [body({ auto: 'yes' }), 400],
  ];
  for (const [raw, status] of bad) { const p = parseRequest(raw, workload); assert.equal(p.ok, false, raw); assert.equal(p.status, status); }
  assert.ok(parseRequest(body({ budgetMs: 200 }), workload).ok);
});

test('the router sends lookups to the fast tier and explanations, lists and long questions to the strong tier', () => {
  const tier = (id) => route(workload.prompts.get(id)).tier;
  for (const id of ['h01', 'h02', 'h03', 'h04', 'h05', 'h06', 'h07', 'h08', 'h09', 'h10']) assert.equal(tier(id), 'fast', id);
  for (const id of ['l01', 'l02', 'l03', 's03', 's05']) assert.equal(tier(id), 'strong', id);
  assert.equal(route({ question: 'x'.repeat(141) }).tier, 'strong');
});

test('auto routes by question and reports why', async () => {
  const fast = done(await collect(body({ promptId: 'h01' }), deps()));
  assert.equal(fast.model, 'nova-lite-apac');
  assert.equal(fast.trace.tier, 'fast');
  assert.deepEqual(fast.trace.reasons, ['short factual lookup']);
  const strong = done(await collect(body({ promptId: 'l01' }), deps()));
  assert.equal(strong.model, 'sonnet-5-global');
  assert.equal(strong.trace.tier, 'strong');
  assert.equal(strong.trace.source, 'primary');
  assert.equal(strong.trace.fallback.armed, true);
  assert.equal(done(await collect(body({ promptId: 'h01' }), deps())).trace.fallback.armed, false, 'the fast tier has nothing cheaper to fall back to');
});

test('cache tiers: miss, exact hit, paraphrase hit with the matched question, and a near-miss that must miss', async () => {
  const d = deps();
  const ask = async (promptId, over) => done(await collect(body({ promptId, namespace: 'n1', ...over }), d));
  const first = await ask('h01');
  assert.equal(first.route, 'model');
  const exact = await ask('h01');
  assert.equal(exact.trace.source, 'exact');
  assert.equal(exact.route, 'response-cache');
  const para = await ask('p01');
  assert.equal(para.trace.source, 'semantic');
  assert.equal(para.trace.matched, workload.prompts.get('h01').question);
  assert.equal(para.model, first.model, 'the cached answer keeps the model that produced it');
  for (const id of ['x01', 'x11']) assert.equal((await ask(id)).route, 'model', `${id} must not be served from the cache`);
  assert.equal((await ask('h01', { namespace: 'other' })).route, 'model', 'another namespace starts cold');
});

test('across the whole labelled set, no near-miss is ever served from the cache', async () => {
  const d = deps();
  for (const [id, p] of workload.prompts) if (p.stratum === 'handbook') await collect(body({ promptId: id, namespace: 'all' }), d);
  const results = { paraphrase: [0, 0], nearmiss: [0, 0] };
  for (const [id, p] of workload.prompts) {
    if (!results[p.stratum]) continue;
    const ev = done(await collect(body({ promptId: id, namespace: 'all' }), d));
    results[p.stratum][1]++;
    if (ev.route === 'response-cache') results[p.stratum][0]++;
  }
  assert.equal(results.nearmiss[0], 0, 'false hits');
  assert.equal(results.paraphrase[0], 6, `paraphrase hits ${JSON.stringify(results)}`);
});

test('a stored answer is only served if its canonical form still matches (a tampered or stale entry is a miss)', async () => {
  const store = new Map();
  const cache = { get: async (k) => store.get(k) ?? null, put: async (k, v) => { store.set(k, structuredClone(v)); } };
  const d = deps({ cache });
  await collect(body({ promptId: 'h01' }), d);
  for (const v of store.values()) if (v.canon) v.canon = 'tampered';
  assert.equal(done(await collect(body({ promptId: 'p01' }), d)).route, 'model');
});

test('fallback before the first token: a slow strong model loses to the fast one, and the loser is aborted', async () => {
  const provider = quick({ ttftMs: (m) => (m === STRONG ? 600 : 5) });
  const ev = done(await collect(body({ promptId: 'l01', budgetMs: 200 }), deps({ provider })));
  assert.equal(ev.model, 'nova-lite-apac');
  assert.equal(ev.trace.source, 'fallback');
  assert.equal(ev.trace.fallback.fired, true);
  assert.equal(ev.trace.fallback.reason, 'budget');
  assert.deepEqual(provider.started, [STRONG, FAST]);
  assert.deepEqual(provider.aborted, [STRONG]);
  assert.ok(ev.srv.first_token_ms < 400, `first token took ${ev.srv.first_token_ms} ms, well under the 600 ms the strong model needed`);
});

test('a strong model that answers within the budget never starts the fallback', async () => {
  const provider = quick({ ttftMs: 5 });
  const ev = done(await collect(body({ promptId: 'l01', budgetMs: 500 }), deps({ provider })));
  assert.equal(ev.model, 'sonnet-5-global');
  assert.equal(ev.trace.fallback.fired, false);
  assert.deepEqual(provider.started, [STRONG]);
  assert.deepEqual(provider.aborted, []);
});

test('a strong model that fails before answering falls back at once, without waiting for the budget', async () => {
  const provider = quick({ failModels: [STRONG] });
  const t = performance.now();
  const ev = done(await collect(body({ promptId: 'l01', budgetMs: 10000 }), deps({ provider })));
  assert.ok(performance.now() - t < 1000);
  assert.equal(ev.model, 'nova-lite-apac');
  assert.equal(ev.trace.fallback.reason, 'error');
});

test('with the fallback switched off a slow model is simply waited for, and if both fail the client gets one error', async () => {
  const slow = quick({ ttftMs: (m) => (m === STRONG ? 250 : 5) });
  const ev = done(await collect(body({ promptId: 'l01', fallback: false, budgetMs: 200 }), deps({ provider: slow })));
  assert.equal(ev.model, 'sonnet-5-global');
  assert.deepEqual(slow.started, [STRONG]);
  const both = await collect(body({ promptId: 'l01' }), deps({ provider: quick({ failModels: [STRONG, FAST] }) }));
  assert.deepEqual(both.map((e) => e.t), ['accepted', 'error']);
});

test('reasoning before the answer does not count as the first token, so it cannot stop the fallback clock', async () => {
  const provider = quick({ reasoning: true, ttftMs: (m) => (m === STRONG ? 500 : 5) });
  const ev = done(await collect(body({ promptId: 'l01', budgetMs: 200 }), deps({ provider })));
  assert.equal(ev.trace.source, 'fallback');
});

test('raceToFirstToken: once the winner has spoken, a later stall is not hedged and nothing is aborted twice', async () => {
  const enc = (list) => async function* (target, signal) { for (const [ms, ev] of list[target]) { await new Promise((r) => setTimeout(r, ms)); if (signal.aborted) throw new Error('aborted'); yield ev; } };
  const start = enc({ a: [[10, { type: 'text', text: 'x' }], [300, { type: 'text', text: 'y' }]], b: [[1, { type: 'text', text: 'B' }]] });
  const out = [];
  for await (const ev of raceToFirstToken({ start, primary: 'a', fallback: 'b', budgetMs: 100 })) out.push(ev);
  assert.deepEqual(out.map((e) => e.text ?? e.winner), ['a', 'x', 'y']);
  assert.equal(out[0].fired, false);
});

test('prompt cache and TTL are decided per model in auto mode', async () => {
  const seen = [];
  const spy = { name: 'mock', async *stream(a) { seen.push(a); yield { type: 'text', text: 'ok' }; yield { type: 'usage', usage: {} }; } };
  await collect(body({ promptId: 'l01', fallback: false }), deps({ provider: spy }));
  await collect(body({ promptId: 'h01' }), deps({ provider: spy }));
  await collect(body({ promptId: 's03', fallback: false }), deps({ provider: spy }));
  assert.equal(seen[0].cachePoint, true);
  assert.equal(seen[0].cacheTtl, '1h');
  assert.deepEqual(seen[0].extra, { thinking: { type: 'disabled' } });
  assert.equal(seen[1].cachePoint, true);
  assert.equal(seen[1].cacheTtl, undefined, 'Nova only supports the 5 minute TTL');
  assert.equal(seen[2].cachePoint, false, 'a short prompt has no long prefix to cache');
});

test('a mis-configured tier is reported as one clear error, not a crash', async () => {
  const evs = await collect(body({ promptId: 'l01' }), deps({ tiers: { fast: 'nova-lite-apac', strong: 'nope' } }));
  assert.equal(evs.at(-1).code, 'misconfigured');
});

test('the scheduled keep-warm event is recognised and nothing else is', () => {
  assert.equal(isWarmEvent({ warm: true }), true);
  for (const e of [{}, { warm: 'true' }, { requestContext: {} }, null, undefined]) assert.equal(isWarmEvent(e), false);
});
