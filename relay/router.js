// Decides which model tier a question needs. Rules on purpose: they are readable, cost nothing at request time,
// and the report measures how often the fast tier answers correctly, so a wrong rule shows up as a number.
// ponytail: rules, not a learned router. Upgrade path: train on the harness's per-tier correctness records.
const NEEDS_REASONING = /\b(summari[sz]e|summary|list|steps?|step[- ]by[- ]step|explain|compare|difference|why|every|walk me through|appeal)\b/i;

export function route(prompt) {
  const reasons = [];
  if (prompt.question.length > 140) reasons.push('long question');
  if (NEEDS_REASONING.test(prompt.question)) reasons.push('asks for a list, steps or an explanation');
  return reasons.length ? { tier: 'strong', reasons } : { tier: 'fast', reasons: ['short factual lookup'] };
}
