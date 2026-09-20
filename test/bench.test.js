import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLocal } from '../relay/local.js';
import { mockProvider } from '../relay/providers/mock.js';
import { loadWorkload } from '../relay/workload.js';
import { call } from '../bench/client.js';
import { runBenchmark, validateConfig } from '../bench/run.js';
import { reportDir } from '../bench/report.js';

test('client: measures ttfb, ttft and completion on a streamed request, with connection setup on a fresh socket', async () => {
  const srv = await startLocal({ provider: mockProvider({ ttftMs: 80, tokensPerSec: 100, outTokens: 10 }) });
  try {
    const body = { promptId: 'h01', model: 'sonnet-5-global', stream: true };
    const r = await call({ url: srv.url, body, fresh: true });
    assert.ok(r.ok, JSON.stringify(r.error));
    assert.equal(r.reused, false);
    assert.ok(r.tcp_ms > 0, 'a new connection must record TCP setup');
    assert.ok(r.ttft_ms >= 80, `ttft ${r.ttft_ms} should include the 80 ms model delay`);
    assert.ok(r.complete_ms > r.ttft_ms + 50, 'the remaining tokens arrive after the first one');
    assert.equal(r.done.usage.outputTokens, 10);
  } finally { await srv.close(); }
});

test('client: buffered mode delivers the first token only when the whole answer is ready', async () => {
  const srv = await startLocal({ provider: mockProvider({ ttftMs: 40, tokensPerSec: 100, outTokens: 20 }) });
  try {
    const r = await call({ url: srv.url, body: { promptId: 'h01', model: 'sonnet-5-global', stream: false } });
    assert.ok(r.ok);
    assert.ok(r.ttft_ms >= 40 + 19 * 10 - 5, `buffered ttft ${r.ttft_ms} should be close to completion`);
    assert.ok(Math.abs(r.complete_ms - r.ttft_ms) < 20);
  } finally { await srv.close(); }
});

test('client: a second request on the kept-alive connection reports reused and no setup cost', async () => {
  const srv = await startLocal();
  try {
    await call({ url: `${srv.url}health`, method: 'GET' });
    const r = await call({ url: `${srv.url}health`, method: 'GET' });
    assert.equal(r.reused, true);
    assert.equal(r.tcp_ms, 0);
  } finally { await srv.close(); }
});

test('client: a refused or invalid request is reported as a failure with the server message, not a crash', async () => {
  const srv = await startLocal();
  try {
    const r = await call({ url: srv.url, body: { promptId: 'nope', model: 'sonnet-5-global' } });
    assert.equal(r.ok, false);
    assert.equal(r.status, 404);
    assert.equal(r.error.t, 'error');
  } finally { await srv.close(); }
  const dead = await call({ url: 'http://127.0.0.1:1/', body: { a: 1 }, timeoutMs: 2000 });
  assert.equal(dead.ok, false);
  assert.equal(dead.error.code, 'network');
});

test('validateConfig reports every problem', () => {
  const p = validateConfig({ endpoints: { a: 'http://x' }, arms: [{ id: 'one', endpoint: 'zzz', model: 'nope' }, { id: 'one', endpoint: 'a', model: 'sonnet-5-global', salt: 'weird' }], comparisons: [{ name: 'c', a: 'one', b: 'missing' }] });
  assert.equal(p.length, 5, p.join('\n'));
});

test('answers are graded against known facts, and a fast wrong answer is recorded as wrong', async () => {
  const workload = await loadWorkload();
  const only = { ...workload, prompts: new Map([...workload.prompts].filter(([id]) => ['h01', 's01'].includes(id))) };
  const texts = { h01: 'The minimum is 75 percent.', s01: 'anything' };
  let wrongNext = false;
  const callImpl = async ({ body }) => ({ ok: true, status: 200, ttft_ms: 5, complete_ms: 9, text: wrongNext && body.promptId === 'h01' ? 'It is 80 percent.' : texts[body.promptId], done: { route: 'model', provider: 'bedrock', cache: 'off', usage: { outputTokens: 5 }, trace: { source: 'primary' } } });
  const config = { endpoints: { e: 'http://x/' }, arms: [{ id: 'fast', endpoint: 'e', model: 'nova-lite-apac' }] };
  const dir = await mkdtemp(join(tmpdir(), 'alr-'));
  await runBenchmark({ config, workload: only, rounds: 1, warmup: 0, seed: 1, vantage: 't', outDir: dir, pauseMs: 0, runId: 'g1', strata: ['handbook', 'short'], callImpl });
  wrongNext = true;
  const dir2 = await mkdtemp(join(tmpdir(), 'alr-'));
  await runBenchmark({ config, workload: only, rounds: 1, warmup: 0, seed: 1, vantage: 't', outDir: dir2, pauseMs: 0, runId: 'g2', strata: ['handbook', 'short'], callImpl });
  const rows = async (d) => (await readFile(join(d, 'raw.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  assert.equal((await rows(dir)).find((r) => r.promptId === 'h01').correct, true);
  assert.equal((await rows(dir2)).find((r) => r.promptId === 'h01').correct, false);
  assert.equal((await rows(dir)).find((r) => r.promptId === 's01').correct, null, 'a question with no known answer is not graded');
});

test('adaptive arms end to end: routing, caches, seeding, per-arm cache isolation and the paraphrase table', async () => {
  const provider = mockProvider({ ttftMs: (m) => (m.includes('sonnet') ? 60 : 10), tokensPerSec: 400, outTokens: 5 });
  const srv = await startLocal({ provider });
  try {
    const full = await loadWorkload();
    const ids = ['h01', 'h02', 'h03', 'h05', 'p01', 'p02', 'p03', 'p05', 'x01', 'x03', 'x05', 'l01'];
    const workload = { ...full, prompts: new Map([...full.prompts].filter(([id]) => ids.includes(id))) };
    const orphanDir = await mkdtemp(join(tmpdir(), 'alr-'));
    await assert.rejects(() => runBenchmark({ config: { endpoints: { local: srv.url }, arms: [{ id: 'a', auto: true, endpoint: 'local', seed: true }] }, workload: { ...full, prompts: new Map([['p02', full.prompts.get('p02')]]) }, rounds: 1, warmup: 0, seed: 1, vantage: 't', outDir: orphanDir, runId: 'o', strata: ['paraphrase'] }), /rewords h02/);
    const config = {
      endpoints: { local: srv.url },
      arms: [
        { id: 'manual', endpoint: 'local', model: 'sonnet-5-global' },
        { id: 'auto', auto: true, endpoint: 'local', seed: true },
        { id: 'auto2', auto: true, endpoint: 'local', seed: true },
        { id: 'router-only', auto: true, endpoint: 'local', responseCache: false, semanticCache: false, fallback: false },
      ],
      comparisons: [{ name: 'Adaptive gateway', a: 'manual', b: 'auto' }],
    };
    const outDir = await mkdtemp(join(tmpdir(), 'alr-'));
    await runBenchmark({ config, workload, rounds: 2, warmup: 1, seed: 3, vantage: 'test', outDir, pauseMs: 0, runId: 'ad', strata: ['handbook', 'paraphrase', 'nearmiss', 'long'] });
    const rows = (await readFile(join(outDir, 'raw.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    const measured = rows.filter((r) => !r.warmup && !r.seed);
    const src = (r) => r.done?.trace?.source;
    assert.ok(rows.some((r) => r.seed), 'paraphrases are seeded with the question they reword');
    assert.ok(measured.every((r) => r.ok), JSON.stringify(measured.find((r) => !r.ok)?.error));
    for (const arm of ['auto', 'auto2']) {
      const mine = measured.filter((r) => r.arm === arm);
      assert.ok(mine.filter((r) => r.stratum === 'handbook').every((r) => src(r) === 'primary'), `${arm}: one arm's cache must never serve another arm`);
      assert.deepEqual([...new Set(mine.filter((r) => r.stratum === 'paraphrase' && src(r) === 'semantic').map((r) => r.promptId))].sort(), ['p01', 'p03'], `${arm}: which rewordings were served from the cache`);
      assert.equal(mine.filter((r) => r.stratum === 'nearmiss' && src(r) === 'semantic').length, 0, `${arm}: near-misses must never hit`);
    }
    assert.ok(measured.filter((r) => r.arm === 'router-only').every((r) => r.done.cache === 'off' && src(r) === 'primary'));
    assert.equal(measured.find((r) => r.arm === 'router-only' && r.promptId === 'l01').done.model, 'sonnet-5-global');
    assert.equal(measured.find((r) => r.arm === 'router-only' && r.promptId === 'h01').done.model, 'nova-lite-apac');

    const { markdown, summary } = await reportDir(outDir);
    const sem = summary.semantic.find((s) => s.arm === 'auto');
    assert.deepEqual([sem.paraphrase.hits, sem.paraphrase.total, sem.nearmiss.hits, sem.nearmiss.total], [4, 8, 0, 6]);
    assert.ok(markdown.includes('## Paraphrase cache'));
    assert.ok(!summary.warnings.some((w) => /near-miss/.test(w)));
    const c = summary.comparisons.find((x) => x.metric === 'ttft_ms');
    assert.ok(c.saved && Number.isFinite(c.saved.point), 'comparisons state the absolute time saved');
    assert.ok(!/[^\x00-\x7F]/.test(markdown), 'report should be plain ASCII');
  } finally { await srv.close(); }
});

test('the report warns when a reasoning model was measured', async () => {
  const { buildReport } = await import('../bench/report.js');
  const rec = (arm, reasoning) => ({ arm, attempt: 1, warmup: false, ok: true, round: 0, promptId: 'h01', stratum: 'handbook', ttft_ms: 500, complete_ms: 900, done: { route: 'model', provider: 'bedrock', cache: 'off', reasoning, usage: { outputTokens: 20 } } });
  const meta = { runId: 't', startedAt: 'x', vantage: 'v', node: 'n', commit: 'c', rounds: 1, warmup: 0, seed: 1, strata: ['handbook'], handbookVersion: 'h', endpoints: {}, comparisons: [], arms: [{ id: 'think', endpoint: 'e', model: 'gpt-oss-20b-inregion' }, { id: 'plain', endpoint: 'e', model: 'nova-lite-apac' }] };
  const { summary } = buildReport([rec('think', true), rec('plain', false)], meta);
  assert.equal(summary.warnings.length, 1);
  assert.match(summary.warnings[0], /think.*reasoning model/);
});

test('the shipped example arms file is valid', async () => {
  const cfg = JSON.parse(await readFile(new URL('../bench/arms.example.json', import.meta.url), 'utf8'));
  assert.deepEqual(validateConfig(cfg), []);
});

test('end to end: run the harness against the local relay, then build the report', async () => {
  const srv = await startLocal({ provider: mockProvider({ ttftMs: 40, tokensPerSec: 200, outTokens: 10 }) });
  try {
    const full = await loadWorkload();
    const workload = { ...full, prompts: new Map([...full.prompts].filter(([id]) => ['h01', 'h02', 'h03'].includes(id))) };
    const model = 'sonnet-5-global';
    const config = {
      endpoints: { local: srv.url },
      arms: [
        { id: 'buffered', endpoint: 'local', model, stream: false },
        { id: 'streamed', endpoint: 'local', model, stream: true },
        { id: 'cold-prefix', endpoint: 'local', model, salt: 'nonce' },
        { id: 'warm-prefix', endpoint: 'local', model, promptCache: true, salt: 'run' },
        { id: 'resp-cache', endpoint: 'local', model, responseCache: true, repeat: 2 },
        { id: 'ping', kind: 'ping', endpoint: 'local', fresh: true },
      ],
      comparisons: [
        { name: 'Streaming', a: 'buffered', b: 'streamed' },
        { name: 'Response cache', a: 'cold-prefix', b: 'resp-cache', bAttempt: 2 },
      ],
    };
    const outDir = await mkdtemp(join(tmpdir(), 'alr-'));
    const { count } = await runBenchmark({ config, workload, rounds: 3, warmup: 1, seed: 1, vantage: 'test', outDir, pauseMs: 0, runId: 'unit', strata: ['handbook'] });
    assert.equal(count, 4 * (1 + 3 * 6)); // per round: 1 ping + 3 prompts x (1+1+1+1+2)

    const rows = (await readFile(join(outDir, 'raw.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    const measured = rows.filter((r) => !r.warmup);
    assert.equal(rows.filter((r) => r.warmup).length, 19);
    assert.ok(measured.every((r) => r.ok), 'all local requests should succeed');
    assert.equal(measured.filter((r) => r.arm === 'cold-prefix' && r.done.usage.cacheReadInputTokens > 0).length, 0, 'the control arm must never read a cache');
    assert.ok(measured.filter((r) => r.arm === 'warm-prefix' && r.done.usage.cacheReadInputTokens > 0).length > 0, 'the warm arm should read the cached prefix');
    assert.ok(measured.filter((r) => r.arm === 'resp-cache' && r.attempt === 2).every((r) => r.done.cache === 'hit'));
    assert.ok(measured.filter((r) => r.arm === 'resp-cache' && r.attempt === 1).every((r) => r.done.cache === 'miss'));

    const { markdown, summary } = await reportDir(outDir);
    assert.ok(markdown.includes('SYNTHETIC DATA'), 'mock data must be flagged');
    assert.equal(summary.synthetic, true);
    assert.ok(Number.isNaN(summary.arms.find((a) => a.arm === 'resp-cache' && a.attempt === 2).otps), 'a cache hit has no decode rate');
    assert.ok(summary.arms.find((a) => a.arm === 'streamed').otps > 0);
    assert.ok(!/[^\x00-\x7F]/.test(markdown), 'report should be plain ASCII so any Windows tool renders it');
    const streaming = summary.comparisons.find((c) => c.name === 'Streaming' && c.metric === 'ttft_ms');
    assert.ok(streaming.point > 1.3, `streaming should cut TTFT, got ${streaming.point}x`);
    assert.ok(streaming.lo > 1, 'the interval should exclude 1');
    const cache = summary.comparisons.find((c) => c.name === 'Response cache' && c.metric === 'complete_ms');
    assert.ok(cache.point > 2, `a response-cache hit should be much faster, got ${cache.point}x`);
  } finally { await srv.close(); }
});
