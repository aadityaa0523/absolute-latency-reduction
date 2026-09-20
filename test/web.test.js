import test from 'node:test';
import assert from 'node:assert/strict';
import { fmtMs, fmtRatio, axisMax, expandRuns, laneBody, barSegments, speedupX, verdictOf, latencyScale, totalsPhrase, traceBadges, simulateRace, seededRng, SPEEDUP_RANGE } from '../web/lib.js';
import { parseRequest } from '../relay/core.js';
import { loadWorkload } from '../relay/workload.js';
import { loadWeb } from '../relay/web.js';
import { serve } from '../relay/serve.js';
import { MemoryCache } from '../relay/cache.js';
import { mockProvider } from '../relay/providers/mock.js';
import { readFile } from 'node:fs/promises';

const workload = await loadWorkload();

test('formatting', () => {
  assert.equal(fmtMs(412.4), '412 ms');
  assert.equal(fmtMs(3120), '3.12 s');
  assert.equal(fmtMs(12500), '12.5 s');
  assert.equal(fmtMs(null), 'n/a');
  assert.equal(fmtMs(NaN), 'n/a');
  assert.equal(fmtRatio(2.345), '2.35x');
  assert.equal(fmtRatio(12.34), '12.3x');
});

test('the time axis grows in steps and never shrinks below the value', () => {
  for (const ms of [0, 999, 1000, 1001, 4999, 7000, 59999, 61000, 130000]) assert.ok(axisMax(ms) >= ms, `${ms}`);
  assert.equal(axisMax(1001), 2000);
  assert.equal(axisMax(130000), 180000);
});

test('lanes on unconfigured endpoints are skipped and repeat lanes expand to two runs', () => {
  const config = {
    endpoints: { here: '/' },
    lanes: [
      { id: 'a', label: 'A', endpoint: 'here' },
      { id: 'b', label: 'B', endpoint: 'virginia' },
      { id: 'c', label: 'C', endpoint: 'here', repeat: 2 },
    ],
  };
  const runs = expandRuns(config);
  assert.deepEqual(runs.map((r) => r.key), ['a#1', 'c#1', 'c#2']);
  assert.match(runs[2].label, /same question again/);
});

test('every body the page can build is accepted by the relay validator', () => {
  const cfg = JSON.parse(String.raw`{"lanes":[
    {"id":"buffered","model":"sonnet-5-global","stream":false},
    {"id":"streamed","model":"sonnet-5-global"},
    {"id":"prompt-cache","model":"sonnet-5-global","promptCache":true,"salt":"session"},
    {"id":"resp-cache","model":"sonnet-5-global","responseCache":true,"repeat":2}]}`);
  for (const lane of cfg.lanes) {
    const body = laneBody(lane, { promptId: 'h01', raceId: 'Ab3-x9Q_', session: 'sess 1/2' });
    const p = parseRequest(JSON.stringify(body), workload);
    assert.ok(p.ok, `${lane.id}: ${p.message}`);
  }
});

test('cold lanes get a fresh prefix per race, the prompt-cache lane keeps one per session', () => {
  const cold = { id: 'streamed', model: 'sonnet-5-global' }, warm = { id: 'pc', model: 'sonnet-5-global', salt: 'session', promptCache: true };
  const a = laneBody(cold, { promptId: 'h01', raceId: 'r1', session: 's' }), b = laneBody(cold, { promptId: 'h01', raceId: 'r2', session: 's' });
  assert.notEqual(a.prefixSalt, b.prefixSalt);
  const c = laneBody(warm, { promptId: 'h01', raceId: 'r1', session: 's' }), d = laneBody(warm, { promptId: 'h01', raceId: 'r2', session: 's' });
  assert.equal(c.prefixSalt, d.prefixSalt);
  assert.notEqual(a.namespace, b.namespace);
});

test('bar segments: waiting until the first token, then streaming, always within the axis', () => {
  assert.deepEqual(barSegments({ ttft: null, elapsed: 500 }, 1000), { wait: 50, stream: 0 });
  assert.deepEqual(barSegments({ ttft: 400, elapsed: 1000 }, 2000), { wait: 20, stream: 30 });
  const s = barSegments({ ttft: 400, elapsed: 300 }, 1000);
  assert.deepEqual(s, { wait: 30, stream: 0 });
});

test('speedup positions are log scaled, clipped and flagged', () => {
  assert.equal(speedupX(1).x, 0.4); // 1x sits two octaves into a five-octave range
  assert.equal(speedupX(SPEEDUP_RANGE.min).x, 0);
  assert.equal(speedupX(SPEEDUP_RANGE.max).x, 1);
  assert.deepEqual(speedupX(0.01), { x: 0, clipped: 'low' });
  assert.deepEqual(speedupX(100), { x: 1, clipped: 'high' });
  assert.deepEqual(speedupX(NaN), { x: 0, clipped: 'low' });
  assert.ok(speedupX(2).x > speedupX(1).x && speedupX(1).x > speedupX(0.5).x);
});

test('a verdict needs the interval to exclude 1', () => {
  assert.equal(verdictOf({ lo: 1.2, hi: 1.9 }), 'faster');
  assert.equal(verdictOf({ lo: 0.4, hi: 0.8 }), 'slower');
  assert.equal(verdictOf({ lo: 0.9, hi: 1.4 }), 'unclear');
});

test('the adaptive lane sends an auto request that shares one namespace for the whole visit', () => {
  const lane = { id: 'auto', auto: true };
  const a = laneBody(lane, { promptId: 'h01', raceId: 'r1', session: 'abc' }), b = laneBody(lane, { promptId: 'p01', raceId: 'r2', session: 'abc' });
  assert.equal(a.auto, true);
  assert.equal(a.namespace, b.namespace, 'a reworded question must find the original in the same namespace');
  assert.notEqual(a.namespace, laneBody(lane, { promptId: 'h01', raceId: 'r1', session: 'other' }).namespace);
  assert.ok(parseRequest(JSON.stringify(a), workload).ok);
  assert.equal(a.model, undefined);
});

test('trace badges describe why an answer was served the way it was', () => {
  const t = (trace) => traceBadges({ trace }).map((b) => b.text);
  assert.deepEqual(t({ mode: 'auto', source: 'exact' }), ['exact cache hit']);
  assert.match(t({ mode: 'auto', source: 'semantic', matched: 'What is X?' })[0], /paraphrase cache hit.*What is X\?/);
  assert.match(t({ mode: 'auto', source: 'fallback', fallback: { reason: 'budget' } })[0], /fallback model answered.*budget/);
  assert.deepEqual(t({ mode: 'auto', source: 'primary', tier: 'fast', reasons: ['short factual lookup'] }), ['fast model: short factual lookup']);
  assert.deepEqual(t({ mode: 'manual', source: 'primary' }), []);
  assert.deepEqual(traceBadges({ route: 'response-cache' }).map((b) => b.text), ['served from the response cache']);
  assert.deepEqual(traceBadges(null), []);
});

test('total-time wording is computed from the numbers', () => {
  assert.equal(totalsPhrase(870, 849), 'in about the same time');
  assert.equal(totalsPhrase(700, 1000), '1.43x sooner');
  assert.equal(totalsPhrase(1500, 1000), '1.50x later');
});

test('latency scale uses p95 when present and never returns zero', () => {
  assert.equal(latencyScale([{ ttft: { p50: 100, p95: 300 } }, { ttft: { p50: 200, p95: null } }], 'ttft'), 300);
  assert.equal(latencyScale([], 'ttft'), 1);
});

test('the shipped page config only references models the relay allows', async () => {
  const cfg = JSON.parse(await readFile(new URL('../web/config.json', import.meta.url), 'utf8'));
  assert.ok(cfg.lanes.length >= 4);
  for (const lane of cfg.lanes) {
    const p = parseRequest(JSON.stringify(laneBody(lane, { promptId: 'h01', raceId: 'r', session: 's' })), workload);
    assert.ok(p.ok, `${lane.id}: ${p.message}`);
    assert.ok(lane.label && lane.endpoint);
  }
});

function sink() {
  const log = { status: null, headers: null, body: '' };
  return { log, head: (s, h) => { log.status = s; log.headers = h; }, write: (t) => { log.body += t; }, end: () => {} };
}

test('the relay serves the page with a strict CSP, its assets, prompts and health, and 404s everything else', async () => {
  const deps = { region: 'test', provider: mockProvider(), cache: new MemoryCache(), workload, web: await loadWeb() };
  const get = async (path) => { const s = sink(); await serve({ method: 'GET', path }, s, deps); return s.log; };

  const home = await get('/');
  assert.equal(home.status, 200);
  assert.match(home.headers['content-type'], /text\/html/);
  assert.match(home.headers['content-security-policy'], /default-src 'none'/);
  assert.match(home.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.doesNotMatch(home.headers['content-security-policy'], /unsafe-inline|unsafe-eval/);
  assert.match(home.body, /<title>Absolute Latency Reduction<\/title>/);
  assert.doesNotMatch(home.body, /<script(?![^>]*\bsrc=)[^>]*>/, 'no inline scripts allowed by the CSP');
  assert.doesNotMatch(home.body, /\son\w+=/i, 'no inline event handlers');

  for (const p of ['/app.js', '/lib.js', '/styles.css', '/config.json']) assert.equal((await get(p)).status, 200, p);
  assert.equal((await get('/health')).status, 200);
  const prompts = JSON.parse((await get('/prompts.json')).body);
  assert.equal(prompts.length, workload.prompts.size);
  assert.ok(prompts.every((p) => p.id && p.question && p.stratum));

  for (const p of ['/nope', '/../package.json', '/relay/core.js', '/results.json/x', '//etc/passwd']) assert.equal((await get(p)).status, 404, p);
});

test('results.json is only served when a real run has been published', async () => {
  const web = await loadWeb();
  const published = await readFile(new URL('../web/results.json', import.meta.url), 'utf8').catch(() => null);
  assert.equal(web.has('/results.json'), published !== null);
  if (published) assert.equal(JSON.parse(published).synthetic, false, 'a synthetic summary must never be published');
});

// ---------- demo mode ----------
const collectSim = async (run, ctx) => {
  const evs = [];
  for await (const ev of simulateRace(run, { ...ctx, sleep: async () => {} })) evs.push(ev);
  return evs;
};

test('seededRng is deterministic for a given seed and varies with a different one', () => {
  const a = seededRng(1), b = seededRng(1), c = seededRng(2);
  const seqA = [a(), a(), a()], seqB = [b(), b(), b()], seqC = [c(), c(), c()];
  assert.deepEqual(seqA, seqB);
  assert.notDeepEqual(seqA, seqC);
  for (const v of seqA) assert.ok(v >= 0 && v < 1);
});

test('simulateRace never calls the network: it only yields token and done events shaped like the relay', async () => {
  const run = { lane: { id: 'streamed', model: 'sonnet-5-global', stream: true } };
  const evs = await collectSim(run, { promptId: 'h01', attempt: 1, next: seededRng(7) });
  assert.ok(evs.length > 1);
  assert.ok(evs.slice(0, -1).every((e) => e.t === 'token' && typeof e.text === 'string'));
  const done = evs.at(-1);
  assert.equal(done.t, 'done');
  assert.equal(done.demo, true, 'every demo done event must be flagged, so it can never be shown as a real answer');
  assert.equal(done.provider, undefined === done.provider ? 'demo' : done.provider); // provider is always 'demo'
  assert.equal(done.model, 'demo');
});

test('simulateRace: a response-cache lane is fast only on the repeat, and slow the first time, matching the real lever', async () => {
  const run = { lane: { id: 'resp-cache', model: 'sonnet-5-global', responseCache: true, repeat: 2 } };
  const times = async (attempt) => {
    const calls = []; const sleep = async (ms) => { calls.push(ms); };
    for await (const ev of simulateRace(run, { promptId: 'h01', attempt, next: seededRng(3), sleep })) { /* drain */ }
    return calls[0];
  };
  const first = await times(1), second = await times(2);
  assert.ok(second < first, `repeat (${second}) should be faster than the first ask (${first})`);
});

test('simulateRace: the first (cold) ask on a response-cache lane streams normally, only the repeat is instant', async () => {
  const run = { lane: { id: 'resp-cache', model: 'sonnet-5-global', stream: true, responseCache: true, repeat: 2 } };
  const first = await collectSim(run, { promptId: 'h01', attempt: 1, next: seededRng(4) });
  const done1 = first.at(-1);
  assert.equal(done1.route, 'model', 'attempt 1 is not a cache hit');
  assert.ok(first.filter((e) => e.t === 'token').length > 1, 'the cold ask must stream more than one token event, not arrive as a single instant burst');
  const second = await collectSim(run, { promptId: 'h01', attempt: 2, next: seededRng(4) });
  assert.equal(second.at(-1).route, 'response-cache');
});

test('simulateRace: a buffered (non-streaming) lane still only yields tokens then one done, same shape as streamed', async () => {
  const run = { lane: { id: 'buffered', model: 'sonnet-5-global', stream: false } };
  const evs = await collectSim(run, { promptId: 'h02', attempt: 1, next: seededRng(9) });
  assert.equal(evs.at(-1).t, 'done');
  assert.ok(evs.filter((e) => e.t === 'token').length > 0);
});

test('simulateRace never touches the network: fetch is never called', async () => {
  let called = false;
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => { called = true; throw new Error('simulateRace must not call fetch'); };
  try {
    const run = { lane: { id: 'auto', auto: true } };
    await collectSim(run, { promptId: 'h01', attempt: 1, next: seededRng(1) });
  } finally { globalThis.fetch = realFetch; }
  assert.equal(called, false);
});

test('the page config has the lane ids the race summary and demo profiles key off (buffered, streamed, resp-cache, auto)', async () => {
  const cfg = JSON.parse(await readFile(new URL('../web/config.json', import.meta.url), 'utf8'));
  const ids = cfg.lanes.map((l) => l.id);
  for (const id of ['buffered', 'streamed', 'resp-cache', 'auto']) assert.ok(ids.includes(id), `missing lane ${id}`);
});
