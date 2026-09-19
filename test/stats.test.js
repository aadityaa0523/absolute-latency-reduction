import test from 'node:test';
import assert from 'node:assert/strict';
import { percentile, sorted, summarize, pairedSpeedup, rng, shuffled } from '../bench/stats.js';

test('percentile interpolates linearly (type 7)', () => {
  const s = sorted([1, 2, 3, 4, 5]);
  assert.equal(percentile(s, 50), 3);
  assert.equal(percentile(s, 0), 1);
  assert.equal(percentile(s, 100), 5);
  assert.equal(percentile(s, 25), 2);
  assert.equal(percentile(sorted([10, 20]), 50), 15);
});

test('summarize hides p95 and p99 when the sample is too small to support them', () => {
  const small = summarize(Array.from({ length: 19 }, (_, i) => i));
  assert.equal(small.p95, null);
  assert.equal(small.p99, null);
  const mid = summarize(Array.from({ length: 20 }, (_, i) => i));
  assert.ok(mid.p95 > 17 && mid.p99 === null);
  const big = summarize(Array.from({ length: 100 }, (_, i) => i));
  assert.ok(big.p99 > 97);
});

test('summarize ignores non-finite values', () => {
  assert.equal(summarize([1, NaN, null, undefined, 3]).n, 2);
});

test('pairedSpeedup: a uniform 2x speedup gives a CI around 2 and excludes 1', () => {
  const a = Array.from({ length: 30 }, (_, i) => 100 + i);
  const b = a.map((x) => x / 2);
  const s = pairedSpeedup(a, b, { seed: 7 });
  assert.ok(Math.abs(s.point - 2) < 1e-9);
  assert.ok(s.lo > 1.9 && s.hi < 2.1);
});

test('pairedSpeedup: identical arms include 1 in the interval, and the result is reproducible from the seed', () => {
  const a = Array.from({ length: 30 }, (_, i) => 100 + ((i * 37) % 23));
  const b = a.map((x, i) => x + (i % 2 ? 3 : -3)); // noise, no real difference
  const s1 = pairedSpeedup(a, b, { seed: 3 }), s2 = pairedSpeedup(a, b, { seed: 3 });
  assert.deepEqual(s1, s2);
  assert.ok(s1.lo < 1 && s1.hi > 1);
});

test('pairedSpeedup rejects mismatched or empty input', () => {
  assert.throws(() => pairedSpeedup([1, 2], [1]));
  assert.throws(() => pairedSpeedup([], []));
});

test('shuffled is deterministic per seed and is a permutation', () => {
  const xs = [1, 2, 3, 4, 5, 6, 7, 8];
  const a = shuffled(xs, rng(5)), b = shuffled(xs, rng(5));
  assert.deepEqual(a, b);
  assert.deepEqual([...a].sort(), xs);
  assert.notDeepEqual(a, xs);
});
