// Fallback before the first token.
//
// Streams from `primary`. If no answer token has arrived within budgetMs, or the primary fails first, the
// `fallback` target is started as well and whichever produces a token first wins; the loser is aborted.
// Once the winner has produced its first token nothing else happens: a stall mid-answer is not hedged, because
// switching models halfway would splice two different answers together.
// This is delayed hedging with a cheaper fallback, not simultaneous duplication, so it costs extra only on slow requests.
//
// start(target, signal) must return an async iterable of provider events ({type:'text'|'reasoning'|'usage'}).
// Yields {type:'route', winner, fired, reason, budgetMs} first, then the winner's events.
export async function* raceToFirstToken({ start, primary, fallback, budgetMs }) {
  const open = (target) => {
    const ac = new AbortController();
    return { target, ac, it: start(target, ac.signal)[Symbol.asyncIterator]() };
  };
  const untilFirstText = async (c) => {
    const buffered = [];
    for (;;) {
      const r = await c.it.next();
      if (r.done) return { buffered, got: false };
      buffered.push(r.value);
      if (r.value.type === 'text') return { buffered, got: true };
    }
  };
  const settle = (c) => untilFirstText(c).then((v) => ({ c, v }), (e) => ({ c, e }));
  const abandon = (c) => { c.ac.abort(); Promise.resolve(c.it.return?.()).catch(() => {}); };

  const a = open(primary), started = [a];
  const live = new Map([[a, settle(a)]]);
  let fired = false, reason = null, won = null, lastError = null;

  if (fallback) {
    let timer;
    const budget = new Promise((r) => { timer = setTimeout(() => r('budget'), budgetMs); });
    const first = await Promise.race([live.get(a), budget]);
    clearTimeout(timer);
    if (first === 'budget') { fired = true; reason = 'budget'; }
    else if (!first.e && first.v.got) won = first;
    else { fired = true; reason = first.e ? 'error' : 'empty'; live.delete(a); lastError = first.e ?? null; }
    if (fired) { const b = open(fallback); started.push(b); live.set(b, settle(b)); }
  }
  try {
    while (!won && live.size) {
      const r = await Promise.race(live.values());
      if (!r.e && r.v.got) won = r;
      else { live.delete(r.c); if (r.e) lastError = r.e; }
    }
    if (!won) throw lastError ?? new Error('the model returned no answer');
    for (const c of started) if (c !== won.c) abandon(c);
    yield { type: 'route', winner: won.c.target, fired, reason, budgetMs };
    yield* won.v.buffered;
    for (;;) {
      const r = await won.c.it.next();
      if (r.done) return;
      yield r.value;
    }
  } finally {
    for (const c of started) abandon(c);
  }
}
