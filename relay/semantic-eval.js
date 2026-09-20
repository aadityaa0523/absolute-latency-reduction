import { canonical } from './canon.js';

// Runs the deployed paraphrase matcher over the labelled question pairs in the workload and reports what it does.
// Nothing here is stored or estimated: it is recomputed from the code and data on this relay every time, so the
// numbers the page shows are exactly what this deployment would do. A near-miss that matches is a false hit,
// which would serve a wrong answer, so it is reported separately from rewordings that match.
export function semanticEval(workload) {
  const all = [...workload.prompts.values()];
  const question = (id) => workload.prompts.get(id)?.question;
  const rows = (stratum) => all
    .filter((p) => p.stratum === stratum && p.base && workload.prompts.has(p.base))
    .map((p) => ({ id: p.id, question: p.question, base: p.base, baseQuestion: question(p.base), matched: canonical(p.question) === canonical(question(p.base)) }));
  const summarize = (items) => ({ hits: items.filter((r) => r.matched).length, total: items.length, items });
  return {
    method: 'canonical form: the same meaning-bearing words in the same order, after removing filler words and applying a short synonym list',
    paraphrase: summarize(rows('paraphrase')),
    nearmiss: summarize(rows('nearmiss')),
  };
}
