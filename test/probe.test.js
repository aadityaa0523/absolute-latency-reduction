import test from 'node:test';
import assert from 'node:assert/strict';
import { serve, probeModel } from '../relay/serve.js';
import { semanticEval } from '../relay/semantic-eval.js';
import { MemoryCache } from '../relay/cache.js';
import { mockProvider } from '../relay/providers/mock.js';
import { loadWorkload } from '../relay/workload.js';
import { MODELS } from '../relay/models.js';

const workload = await loadWorkload();
const tiers = { fast: 'nova-lite-apac', strong: 'sonnet-5-global' };
const deps = (o = {}) => ({ workload, region: 'test', provider: mockProvider({ ttftMs: 1, tokensPerSec: 2000, outTokens: 2 }), cache: new MemoryCache(), tiers, ...o });
const get = async (path, d) => {
  const log = { status: null, body: '' };
  await serve({ method: 'GET', path }, { head: (s) => { log.status = s; }, write: (t) => { log.body += t; }, end: () => {} }, d);
  return { status: log.status, json: JSON.parse(log.body) };
};
const failing = (name, message) => { const calls = []; return { name: 'bedrock', calls, async *stream(a) { calls.push(a); throw Object.assign(new Error(message), { name }); } }; };

test('the semantic check is computed from the deployed matcher: 6 of 12 rewordings, 0 of 12 look-alikes', async () => {
  const r = await get('/semantic-eval.json', deps());
  assert.equal(r.status, 200);
  assert.deepEqual([r.json.paraphrase.hits, r.json.paraphrase.total, r.json.nearmiss.hits, r.json.nearmiss.total], [6, 12, 0, 12]);
  assert.deepEqual(r.json.paraphrase.items.filter((i) => i.matched).map((i) => i.id), ['p01', 'p03', 'p04', 'p06', 'p08', 'p10']);
  for (const item of [...r.json.paraphrase.items, ...r.json.nearmiss.items]) {
    assert.ok(item.question && item.baseQuestion && typeof item.matched === 'boolean', item.id);
  }
  assert.match(r.json.method, /same meaning-bearing words in the same order/);
});

test('the semantic check reports a false hit if a look-alike ever matches (so a regression cannot hide)', () => {
  const rigged = { ...workload, prompts: new Map(workload.prompts) };
  rigged.prompts.set('x01', { ...workload.prompts.get('x01'), question: workload.prompts.get('h01').question });
  const r = semanticEval(rigged);
  assert.equal(r.nearmiss.hits, 1);
  assert.equal(r.nearmiss.items.find((i) => i.id === 'x01').matched, true);
});

test('the model probe says ok when the model answers, and names the fast tier it asked', async () => {
  const r = await get('/health/model', deps());
  assert.deepEqual(r.json, { ok: true, model: 'nova-lite-apac' });
});

test('the model probe reports a refusal by error name with a short message, and nothing else', async () => {
  const long = 'Your account is currently being verified. '.repeat(10);
  const r = await get('/health/model', deps({ provider: failing('ValidationException', long) }));
  assert.equal(r.json.ok, false);
  assert.equal(r.json.name, 'ValidationException');
  assert.ok(r.json.message.length <= 160);
  assert.deepEqual(Object.keys(r.json).sort(), ['message', 'name', 'ok']);
});

test('the probe asks the fast tier model with a tiny request', async () => {
  const p = failing('X', 'x');
  await probeModel(deps({ provider: p }));
  assert.equal(p.calls.length, 1);
  assert.equal(p.calls[0].modelId, MODELS['nova-lite-apac'].id);
  assert.ok(p.calls[0].maxTokens <= 5);
});

test('the probe is cached and shared: many page loads cost one model call', async () => {
  const p = failing('X', 'x');
  const d = deps({ provider: p });
  await Promise.all([probeModel(d), probeModel(d), probeModel(d)]);
  await probeModel(d);
  assert.equal(p.calls.length, 1);
});

test('the probe asks again once its cache has expired, so the page notices when access is granted', async () => {
  let allowed = false, calls = 0;
  const provider = { name: 'bedrock', async *stream() { calls++; if (!allowed) throw Object.assign(new Error('blocked'), { name: 'ValidationException' }); yield { type: 'text', text: 'ok' }; } };
  const d = deps({ provider, probeTtlMs: 0 });
  assert.equal((await probeModel(d)).ok, false);
  allowed = true;
  assert.equal((await probeModel(d)).ok, true);
  assert.equal(calls, 2);
});

test('a model that returns no text is reported as not ok, not as healthy', async () => {
  const empty = { name: 'bedrock', async *stream() { yield { type: 'usage', usage: {} }; } };
  const r = await probeModel(deps({ provider: empty }));
  assert.equal(r.ok, false);
  assert.equal(r.name, 'NoAnswer');
});
