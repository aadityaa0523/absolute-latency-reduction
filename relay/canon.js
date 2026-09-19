// Canonical form of a question, for the paraphrase cache.
//
// Deliberately conservative: two questions share a canonical form only when every meaning-bearing word
// survives, in the same order. A different number, weekday, negation or qualifier therefore can never match,
// because a wrong cached answer is worse than a miss. Recall comes from the filler and synonym lists.
// ponytail: a hash of the canonical form, no similarity search. When Bedrock embeddings are available, add them
// as a candidate generator in front of this same check.
const NUM = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, twenty: 20, thirty: 30, hundred: 100 };

export function stem(w) {
  if (/^\d/.test(w) || w.length < 4) return w;
  let s = w;
  if (s.endsWith('ies') && s.length > 4) s = `${s.slice(0, -3)}y`;
  else if (s.endsWith('ing') && s.length > 5) s = s.slice(0, -3);
  else if (s.endsWith('ed') && s.length > 4) s = s.slice(0, -2);
  else if (s.endsWith('s') && !s.endsWith('ss') && s.length > 3) s = s.slice(0, -1);
  if (s.endsWith('e') && s.length > 3) s = s.slice(0, -1);
  return s;
}

// Words that carry no meaning in a question. Stemmed the same way as the input before comparison.
const FILLER = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'am', 'do', 'does', 'did', 'done', 'can', 'could', 'will', 'would',
  'shall', 'should', 'may', 'might', 'must', 'have', 'has', 'had', 'i', 'me', 'my', 'we', 'us', 'our', 'you', 'your', 'it', 'its',
  'of', 'in', 'on', 'at', 'to', 'for', 'from', 'by', 'with', 'about', 'as', 'into', 'per', 'please', 'tell', 'what', 'which', 'there',
  'this', 'that', 'these', 'those', 'then', 'so', 'also', 'just', 'get', 'give', 'need', 'require', 'how', 'and', 'within',
].map(stem));

// Words that mean the same thing for this domain; both sides map to the first.
const SYN = Object.fromEntries(Object.entries({
  min: ['minimum', 'minimal', 'least', 'lowest'], max: ['maximum', 'most', 'highest'], lab: ['laboratory'],
  fee: ['cost', 'charge', 'price'], happen: ['occur'], shut: ['close', 'closes', 'closed'],
}).flatMap(([to, froms]) => froms.map((f) => [stem(f), to])));

export function canonical(question) {
  const t = question.normalize('NFKC').toLowerCase()
    .replace(/n['’]t\b/g, ' not')
    .replace(/[%₹$]/g, ' ')
    .replace(/[^a-z0-9.\s]/g, ' ')
    .replace(/(?<!\d)\.|\.(?!\d)/g, ' ');
  const out = [];
  for (const raw of t.split(/\s+/)) {
    if (!raw || (raw.length === 1 && !/\d/.test(raw))) continue;
    const w = stem(Object.hasOwn(NUM, raw) ? String(NUM[raw]) : raw);
    if (FILLER.has(w)) continue;
    out.push(SYN[w] ?? w);
  }
  return out.join(' ');
}
