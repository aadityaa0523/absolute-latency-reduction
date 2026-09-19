import test from 'node:test';
import assert from 'node:assert/strict';
import { canonical, stem } from '../relay/canon.js';
import { loadWorkload } from '../relay/workload.js';

const workload = await loadWorkload();
const all = [...workload.prompts.values()];
const q = (id) => workload.prompts.get(id).question;

test('stemming is consistent across word forms', () => {
  assert.equal(stem('gates'), stem('gate'));
  assert.equal(stem('closed'), stem('close'));
  assert.equal(stem('reported'), stem('report'));
  assert.equal(stem('fees'), stem('fee'));
  assert.equal(stem('75'), '75');
});

test('rewordings that only change filler, case, punctuation or a listed synonym share a canonical form', () => {
  assert.equal(canonical("What's the min attendance needed for each course?"), canonical('What is the minimum attendance required in each course?'));
  assert.equal(canonical('HOW MANY BOOKS can an undergraduate borrow at once??'), canonical('How many books can an undergraduate borrow at once?'));
  assert.equal(canonical('What is the fee?'), canonical('what does it cost'));
});

test('a different number, weekday, negation or qualifier can never share a canonical form', () => {
  const pairs = [
    ['after 4 weeks', 'after 5 weeks'], ['hostel gates close on Friday', 'hostel gates close on Sunday'],
    ['is attendance required', 'is attendance not required'], ['is attendance required', "isn't attendance required"],
    ['minimum attendance', 'maximum attendance'], ['undergraduate', 'postgraduate'], ['library book', 'lab book'],
    ['pay 2 rupees', 'pay two hundred rupees'],
  ];
  for (const [a, b] of pairs) assert.notEqual(canonical(a), canonical(b), `${a} / ${b}`);
});

test('word order matters, so reversed roles do not match', () => {
  assert.notEqual(canonical('Does the dean approve the committee?'), canonical('Does the committee approve the dean?'));
});

test('the canonical form of an empty or filler-only question is empty, never a shared key with real questions', () => {
  assert.equal(canonical('the a is'), '');
  assert.notEqual(canonical('What is the fee?'), '');
});

// The labelled evaluation. Every paraphrase and near-miss in the workload names the question it is compared with.
// Near-misses must never match: a false hit returns a wrong answer. Paraphrases are allowed to miss; the miss rate is
// reported honestly rather than tuned away, because loosening the rules is how false hits appear.
test('paraphrase cache on the labelled set: zero false hits, and the recall is what it is', () => {
  const paraphrases = all.filter((p) => p.stratum === 'paraphrase'), nearMisses = all.filter((p) => p.stratum === 'nearmiss');
  const hit = (p) => canonical(p.question) === canonical(q(p.base));
  const falseHits = nearMisses.filter(hit);
  const hits = paraphrases.filter(hit);
  assert.equal(falseHits.length, 0, `false hits: ${falseHits.map((p) => p.id)}`);
  assert.ok(paraphrases.length >= 10 && nearMisses.length >= 10, 'the labelled set should not shrink');
  // Pin the current recall so a change to the lexicon that loosens or tightens it is a visible decision.
  assert.deepEqual(hits.map((p) => p.id), ['p01', 'p03', 'p04', 'p06', 'p08', 'p10'], 'recall changed: review the new matches for correctness');
});

test('every paraphrase and near-miss names an existing base question, and no two questions collide by accident', () => {
  for (const p of all.filter((x) => x.base)) assert.ok(workload.prompts.has(p.base), `${p.id} base ${p.base}`);
  const seen = new Map();
  for (const p of all.filter((x) => x.stratum === 'handbook')) {
    const c = canonical(p.question);
    assert.ok(!seen.has(c), `${p.id} collides with ${seen.get(c)}`);
    seen.set(c, p.id);
  }
});

test('every keyed question has expect patterns that compile', () => {
  for (const p of all.filter((x) => x.expect)) for (const e of p.expect) assert.doesNotThrow(() => new RegExp(e, 'i'), `${p.id}: ${e}`);
});
