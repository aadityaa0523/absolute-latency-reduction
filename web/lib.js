// Pure helpers for the demo page (no DOM), so they can be unit tested with node:test.
const STEPS = [1000, 2000, 3000, 5000, 8000, 12000, 20000, 30000, 60000];
const safe = (s) => String(s).replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 40);

export const fmtMs = (ms) => (ms == null || !Number.isFinite(ms) ? 'n/a' : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s`);
export const fmtRatio = (v) => (Number.isFinite(v) ? `${v.toFixed(v >= 10 ? 1 : 2)}x` : 'n/a');

// A shared time axis that only grows in fixed steps, so bars do not jitter while the race runs.
export const axisMax = (ms) => STEPS.find((s) => s >= ms) ?? Math.ceil(ms / 60000) * 60000;

// One lane becomes one run, or two when it repeats (to show a response-cache hit on the second ask).
// A lane whose endpoint is not configured is skipped rather than shown broken.
export function expandRuns(config) {
  const runs = [];
  for (const lane of config.lanes) {
    if (!config.endpoints[lane.endpoint]) continue;
    const n = lane.repeat ?? 1;
    for (let attempt = 1; attempt <= n; attempt++) {
      runs.push({ key: `${lane.id}#${attempt}`, lane, attempt, of: n, label: n > 1 ? `${lane.label} (${attempt === 1 ? 'first ask' : 'same question again'})` : lane.label });
    }
  }
  return runs;
}

// Cold prefix for every lane by default, so nothing is cached by accident. Only a lane with salt "session"
// keeps one prefix for the whole page visit, which is what lets Bedrock's prompt cache be seen working.
// The response-cache namespace is the race id, so every race starts cold and the repeat is the first hit.
export function laneBody(lane, { promptId, raceId, session }) {
  // The adaptive lane remembers within a page visit, so asking a question and then a reworded version shows the paraphrase cache.
  if (lane.auto) {
    return { promptId, auto: true, maxTokens: lane.maxTokens ?? 200, namespace: safe(`s-${session}`), prefixSalt: safe(`s-${session}`), ...(lane.budgetMs ? { budgetMs: lane.budgetMs } : {}) };
  }
  return {
    promptId, model: lane.model, stream: lane.stream ?? true, responseCache: !!lane.responseCache, promptCache: !!lane.promptCache,
    maxTokens: lane.maxTokens ?? 200, namespace: safe(raceId),
    prefixSalt: lane.salt === 'session' ? safe(`s-${session}`) : safe(`n-${raceId}-${lane.id}`),
  };
}

// Percent widths of the two bar segments: waiting for the first token, then streaming.
export function barSegments({ ttft, elapsed }, axis) {
  const wait = ttft == null ? elapsed : Math.min(ttft, elapsed);
  const stream = ttft == null ? 0 : Math.max(0, elapsed - ttft);
  return { wait: (100 * wait) / axis, stream: (100 * stream) / axis };
}

// Log-scale position (0..1) for a speedup ratio, clipped to the visible range and flagged when clipped.
export const SPEEDUP_RANGE = { min: 0.25, max: 8, ticks: [0.25, 0.5, 1, 2, 4, 8] };
export function speedupX(v, { min, max } = SPEEDUP_RANGE) {
  if (!Number.isFinite(v) || v <= 0) return { x: 0, clipped: 'low' };
  const x = (Math.log2(v) - Math.log2(min)) / (Math.log2(max) - Math.log2(min));
  return x < 0 ? { x: 0, clipped: 'low' } : x > 1 ? { x: 1, clipped: 'high' } : { x, clipped: null };
}

// The interval has to exclude 1 for the page to call a difference real.
export const verdictOf = (c) => (c.lo > 1 ? 'faster' : c.hi < 1 ? 'slower' : 'unclear');

// Plain-language reasons an answer was served the way it was, taken from the relay's own trace.
export function traceBadges(done) {
  const t = done?.trace, out = [];
  if (!t) return done?.route === 'response-cache' ? [{ text: 'served from the response cache' }] : out;
  if (t.source === 'exact') out.push({ text: 'exact cache hit' });
  else if (t.source === 'semantic') out.push({ text: `paraphrase cache hit (same question as: "${t.matched}")` });
  else if (t.source === 'fallback') out.push({ text: `fallback model answered: the strong model was too slow (${t.fallback?.reason ?? 'budget'})` });
  else if (t.mode === 'auto') out.push({ text: `${t.tier} model: ${t.reasons?.[0] ?? 'routed'}` });
  return out;
}

// How the total time of two setups compares, in words that are computed, never assumed.
export function totalsPhrase(end, reference) {
  const d = (end - reference) / reference;
  if (Math.abs(d) < 0.15) return 'in about the same time';
  return d < 0 ? `${fmtRatio(reference / end)} sooner` : `${fmtRatio(end / reference)} later`;
}

export const latencyScale =(arms, key) => Math.max(1, ...arms.map((a) => a[key]?.p95 ?? a[key]?.p50 ?? 0));


// ---------- demo mode: a local, honestly-labelled simulation ----------
// No network call reaches the relay or Bedrock. Used when the live model is unavailable (e.g. an account
// verification hold) so the interaction itself — the thing "Best UI" judges rate — can still be seen working.
// Every event it yields is shaped exactly like the real relay's NDJSON events, so the same paint() code in
// app.js renders both paths with no branching, and demo output can never be confused with a live answer
// because s.done.demo === true is checked before anything is shown as real.

// mulberry32: small, fast, seedable. Deterministic for tests; seeded from Date.now() on the page so replays differ.
export function seededRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DEMO_ANSWERS = {
  h01: 'The handbook requires at least 75 percent attendance in each course (Clause 1).',
  h02: 'The late fee is 2 rupees per day for each overdue book (Clause 2).',
  h03: 'Hostel gates close at 11:30 pm on Friday and Saturday (Clause 3).',
  h04: 'You have 5 working days, and the fee is 500 rupees per paper (Clause 5).',
  default: 'Based on the handbook, here is the answer to your question, drawn from the relevant clause.',
};
const demoText = (promptId) => DEMO_ANSWERS[promptId] ?? DEMO_ANSWERS.default;

// Per-lane demo profile: roughly what that setup would look like against a real model, kept honest by being
// visibly slower/faster in the same relative order the real levers would produce, never a specific promised
// number. `attempt` matters first: only a *repeat* of a response-cache lane is a cache hit — the first ask on
// that same lane is an ordinary cold call and must not inherit the repeat's near-zero timing.
function demoProfile(lane, attempt, next) {
  const jitter = (base, spread) => base + (next() - 0.5) * spread;
  if (lane.responseCache && lane.repeat && attempt > 1) return { ttft: jitter(6, 3), tokensPerSec: Infinity, cachePoint: false, cacheHit: true };
  if (lane.stream === false) return { ttft: jitter(2200, 300), tokensPerSec: 45, cachePoint: false };
  if (lane.promptCache) return { ttft: jitter(180, 40), tokensPerSec: 60, cachePoint: true };
  if (lane.auto) return { ttft: jitter(160, 60), tokensPerSec: 65, cachePoint: false, auto: true };
  return { ttft: jitter(650, 150), tokensPerSec: 55, cachePoint: false };
}

// Async generator of relay-shaped events: {t:'token',text} then {t:'done',...}. `sleep` is injected so tests
// run instantly; the page passes the real setTimeout-based one.
export async function* simulateRace(run, { promptId, attempt, next = seededRng(Date.now()), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const p = demoProfile(run.lane, attempt, next);
  await sleep(p.ttft);
  const words = demoText(promptId).split(' ');
  const n = Math.min(words.length, 40);
  for (let i = 0; i < n; i++) {
    if (i && p.tokensPerSec !== Infinity) await sleep(1000 / p.tokensPerSec);
    yield { t: 'token', text: `${words[i]} ` };
  }
  const badges = [];
  if (p.cacheHit) badges.push('served from the response cache (demo)');
  else if (p.cachePoint) badges.push('prompt cache would apply here (demo)');
  else if (p.auto) badges.push(`${run.lane.id === 'auto' ? 'fast' : 'strong'} model chosen by the router (demo)`);
  yield { t: 'done', demo: true, route: p.cacheHit ? 'response-cache' : 'model', model: 'demo', provider: 'demo', badges, usage: { outputTokens: n } };
}
