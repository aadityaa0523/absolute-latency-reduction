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

// How the total time of two setups compares, in words that are computed, never assumed.
export function totalsPhrase(end, reference) {
  const d = (end - reference) / reference;
  if (Math.abs(d) < 0.15) return 'in about the same time';
  return d < 0 ? `${fmtRatio(reference / end)} sooner` : `${fmtRatio(end / reference)} later`;
}

export const latencyScale =(arms, key) => Math.max(1, ...arms.map((a) => a[key]?.p95 ?? a[key]?.p50 ?? 0));
