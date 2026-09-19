// Small, dependency-free statistics. Percentiles use linear interpolation (Hyndman-Fan type 7).
export function rng(seed) { // mulberry32, so bootstrap results are reproducible from the run seed
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const sorted = (xs) => xs.filter(Number.isFinite).sort((a, b) => a - b);

export function percentile(s, p) {
  if (!s.length) return NaN;
  const h = ((s.length - 1) * p) / 100, lo = Math.floor(h), hi = Math.ceil(h);
  return s[lo] + (s[hi] - s[lo]) * (h - lo);
}

export const median = (xs) => percentile(sorted(xs), 50);

// p95 needs at least 20 samples and p99 at least 100, otherwise they are just the maximum in disguise.
export function summarize(values) {
  const s = sorted(values), n = s.length;
  return {
    n,
    mean: n ? s.reduce((a, b) => a + b, 0) / n : NaN,
    min: s[0] ?? NaN,
    p50: percentile(s, 50),
    p95: n >= 20 ? percentile(s, 95) : null,
    p99: n >= 100 ? percentile(s, 99) : null,
    max: s[n - 1] ?? NaN,
  };
}

// Speedup of arm b over arm a on matched pairs: median(a) / median(b), with a percentile-bootstrap CI that
// resamples whole pairs. >1 means b is faster.
export function pairedSpeedup(a, b, { reps = 2000, seed = 1, alpha = 0.05 } = {}) {
  if (a.length !== b.length || !a.length) throw new Error('pairedSpeedup needs two equal-length, non-empty arrays');
  const n = a.length, next = rng(seed), draws = [];
  for (let r = 0; r < reps; r++) {
    const ra = new Array(n), rb = new Array(n);
    for (let i = 0; i < n; i++) { const j = Math.floor(next() * n); ra[i] = a[j]; rb[i] = b[j]; }
    draws.push(median(ra) / median(rb));
  }
  const s = sorted(draws);
  return { n, point: median(a) / median(b), lo: percentile(s, (alpha / 2) * 100), hi: percentile(s, (1 - alpha / 2) * 100) };
}

export function shuffled(xs, next) { // Fisher-Yates with a seeded generator
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}
