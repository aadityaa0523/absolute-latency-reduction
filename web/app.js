import { fmtMs, fmtRatio, axisMax, expandRuns, laneBody, barSegments, speedupX, verdictOf, latencyScale, totalsPhrase, traceBadges, SPEEDUP_RANGE } from './lib.js';

const $ = (sel) => document.querySelector(sel);
const SVG_TAGS = new Set(['svg', 'g', 'line', 'rect', 'circle', 'path', 'text']);
const rid = (n = 8) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join('');
const session = rid(8);

// Builds DOM with textContent only, so nothing from the network is ever parsed as HTML.
function h(tag, attrs = {}, ...kids) {
  const el = SVG_TAGS.has(tag) ? document.createElementNS('http://www.w3.org/2000/svg', tag) : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) el.setAttribute(k, v === true ? '' : String(v));
  for (const k of kids.flat()) if (k != null && k !== false) el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return el;
}

const fetchJson = async (path) => {
  const r = await fetch(path, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
};

let config, health, raceActive = false;

async function boot() {
  let prompts;
  try {
    [config, prompts] = await Promise.all([fetchJson('/config.json'), fetchJson('/prompts.json')]);
  } catch (e) {
    $('#status').textContent = 'Could not load the page data. Reload to try again.';
    return;
  }
  health = await fetchJson('/health').catch(() => null);
  paintStatus();
  // Open connections and wake any cold container before the first race, so the first lane is not penalised for setup.
  for (const u of Object.values(config.endpoints)) fetch(new URL('health', new URL(u, location.href)).href, { cache: 'no-store' }).catch(() => {});
  buildPromptPicker(prompts);
  $('#controls').addEventListener('submit', (e) => { e.preventDefault(); startRace(); });
  renderResults(await fetchJson('/results.json').catch(() => null));
}

function paintStatus() {
  const s = $('#status'), b = $('#banner');
  if (!health) { s.textContent = 'Relay not reachable'; s.classList.add('warn'); return; }
  s.replaceChildren(h('span', { class: 'dot' }), `Relay live in ${health.region} (${health.provider === 'bedrock' ? 'Amazon Bedrock' : 'mock model'})`);
  s.classList.toggle('warn', health.provider !== 'bedrock');
  if (health.provider !== 'bedrock') {
    b.hidden = false;
    b.textContent = 'SYNTHETIC: this relay is using a mock model. Timings below are a test of the page, not measurements of AWS or Amazon Bedrock.';
  }
}

function buildPromptPicker(prompts) {
  const groups = {
    short: 'General questions (short prompt)', handbook: 'About the handbook (long stable prefix)', long: 'Long answers',
    paraphrase: 'Reworded questions (ask the original first, then one of these)', nearmiss: 'Look similar but differ (must not be served from the cache)',
  };
  const sel = $('#prompt');
  for (const [stratum, label] of Object.entries(groups)) {
    const items = prompts.filter((p) => p.stratum === stratum);
    if (items.length) sel.append(h('optgroup', { label }, items.map((p) => h('option', { value: p.id }, p.question))));
  }
  $('#hint').textContent = 'Run it twice: the cache lanes only show their effect on a repeat.';
}

// ---------- live race ----------
const errText = (ev) => (ev.code === 'upstream' ? `The model refused this request: ${ev.name}: ${ev.message}` : ev.code === 'bad_request' ? `Request rejected: ${ev.message}` : ev.message ?? 'Request failed');

function newState() { return { status: 'waiting', t0: null, ttfb: null, ttft: null, end: null, text: '', done: null, error: null }; }

function onEvent(s, ev, now) {
  if (ev.t === 'token') { s.ttft ??= now; s.text += ev.text; }
  else if (ev.t === 'done') { s.done = ev; s.end = now; }
  else if (ev.t === 'error') { s.error = { message: errText(ev) }; s.end = now; }
}

async function runOne(run, ctx) {
  const s = run.s;
  s.status = 'running';
  s.t0 = performance.now();
  try {
    const url = new URL(config.endpoints[run.lane.endpoint], location.href).href;
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(laneBody(run.lane, ctx)), cache: 'no-store' });
    const reader = res.body.getReader(), dec = new TextDecoder();
    let buf = '';
    const take = (line) => { try { onEvent(s, JSON.parse(line), performance.now() - s.t0); } catch { /* not an event line */ } };
    for (;;) {
      const { value, done } = await reader.read();
      if (value) {
        s.ttfb ??= performance.now() - s.t0;
        buf += dec.decode(value, { stream: true });
        for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line) take(line); }
      }
      if (done) break;
    }
    if (buf.trim()) take(buf);
    if (!s.done && !s.error) s.error = { message: `No answer received (HTTP ${res.status})` };
  } catch (e) {
    s.error = { message: `Network error: ${e.message}` };
  }
  s.end ??= performance.now() - s.t0;
  s.status = s.error ? 'error' : 'done';
}

function laneRow(run) {
  const wait = h('span', { class: 'seg wait' }), stream = h('span', { class: 'seg stream' });
  const nums = Object.fromEntries([['ttft', 'First token'], ['done', 'Done'], ['tps', 'Speed']].map(([k, label]) => [k, h('span', { class: 'v' }, 'n/a')]));
  const track = h('div', { class: 'track', role: 'img', 'aria-label': `${run.label}: waiting to start` }, wait, stream);
  const badges = h('span', { class: 'badges' }), text = h('p', { class: 'text', 'aria-hidden': 'true' }), err = h('p', { class: 'err', role: 'alert', hidden: true });
  const sub = `${run.lane.auto ? 'automatic model choice' : run.lane.model} · ${run.lane.endpoint === 'here' ? (health?.region ?? 'this relay') : run.lane.endpoint}`;
  const el = h('div', { class: 'lane' },
    h('div', { class: 'name' }, run.label, h('span', { class: 'sub' }, sub)),
    track,
    h('div', { class: 'nums' }, ...[['ttft', 'First token'], ['done', 'Done'], ['tps', 'Speed']].map(([k, label]) => h('div', {}, h('span', { class: 'k' }, label), nums[k]))),
    h('div', { class: 'extra' }, badges, text, err));
  run.dom = { el, wait, stream, track, nums, badges, text, err };
  return el;
}

function paint(run, axis) {
  const s = run.s, d = run.dom;
  if (s.status === 'waiting') return;
  const elapsed = s.status === 'running' ? performance.now() - s.t0 : s.end;
  const seg = barSegments({ ttft: s.ttft, elapsed }, axis);
  d.wait.style.width = `${seg.wait}%`;
  d.stream.style.width = `${seg.stream}%`;
  d.nums.ttft.textContent = s.ttft != null ? fmtMs(s.ttft) : s.status === 'running' ? 'waiting…' : 'n/a';
  d.nums.done.textContent = s.status === 'running' ? fmtMs(elapsed) : s.error ? 'failed' : fmtMs(s.end);
  const out = s.done?.usage?.outputTokens;
  // A decode rate only means something when tokens really streamed; a buffered or cached answer arrives all at once.
  d.nums.tps.textContent = run.lane.stream !== false && s.done?.route === 'model' && out > 1 && s.end > s.ttft ? `${Math.round((out / (s.end - s.ttft)) * 1000)} tok/s` : 'n/a';
  d.text.textContent = s.text || (s.status === 'running' ? (run.lane.stream === false ? 'Waiting for the whole answer…' : '') : '');
  if (s.status !== 'running') {
    d.track.setAttribute('aria-label', s.error ? `${run.label}: failed` : `${run.label}: first token ${fmtMs(s.ttft)}, done ${fmtMs(s.end)}`);
    d.err.hidden = !s.error;
    if (s.error) d.err.textContent = s.error.message;
    if (!d.badges.childElementCount && s.done) {
      const u = s.done.usage ?? {};
      for (const b of traceBadges(s.done)) d.badges.append(h('span', { class: 'badge' }, b.text));
      if (u.cacheReadInputTokens > 0) d.badges.append(h('span', { class: 'badge' }, `prompt cache read ${u.cacheReadInputTokens} tokens`));
      if (u.cacheWriteInputTokens > 0) d.badges.append(h('span', { class: 'badge' }, `prompt cache wrote ${u.cacheWriteInputTokens} tokens`));
      if (s.done.provider === 'mock') d.badges.append(h('span', { class: 'badge mock' }, 'mock model'));
    }
  }
}

async function startRace() {
  if (raceActive || !config) return;
  raceActive = true;
  const button = $('#run');
  button.disabled = true;
  const raceId = rid(8), promptId = $('#prompt').value;
  const runs = expandRuns(config).map((r) => ({ ...r, s: newState() }));
  const lanesEl = $('#lanes');
  lanesEl.replaceChildren(...runs.map(laneRow));
  $('#axis').hidden = false;
  $('#race-summary').textContent = '';
  $('#hint').textContent = 'Racing…';

  let axis = 1000, frame;
  const tick = () => {
    const longest = Math.max(0, ...runs.filter((r) => r.s.status !== 'waiting').map((r) => (r.s.status === 'running' ? performance.now() - r.s.t0 : r.s.end)));
    axis = Math.max(axis, axisMax(longest));
    $('#axis-max').textContent = fmtMs(axis);
    runs.forEach((r) => paint(r, axis));
    frame = requestAnimationFrame(tick);
  };
  tick();

  const byLane = new Map();
  for (const r of runs) byLane.set(r.lane.id, [...(byLane.get(r.lane.id) ?? []), r]);
  await Promise.all([...byLane.values()].map(async (rs) => {
    for (const r of rs) {
      await runOne(r, { promptId, raceId, session });
      if (r.s.error) { rs.filter((x) => x.s.status === 'waiting').forEach((x) => { x.s.status = 'error'; x.s.end = 0; x.s.error = { message: 'Skipped because the first ask failed.' }; }); break; }
    }
  }));
  cancelAnimationFrame(frame);
  tick(); cancelAnimationFrame(frame);
  raceSummary(runs);
  $('#hint').textContent = 'Run it again: the cache lanes only show their effect on a repeat.';
  button.disabled = false;
  raceActive = false;
}

function raceSummary(runs) {
  const get = (id, attempt = 1) => runs.find((r) => r.lane.id === id && r.attempt === attempt);
  const ok = (r) => r && r.s.status === 'done';
  const buffered = get('buffered'), streamed = get('streamed'), hit = get('resp-cache', 2), cold = get('resp-cache', 1);
  const parts = [];
  if (ok(buffered) && ok(streamed)) {
    parts.push(`Streaming showed the first token ${fmtRatio(buffered.s.ttft / streamed.s.ttft)} sooner than waiting for the whole answer (${fmtMs(streamed.s.ttft)} against ${fmtMs(buffered.s.ttft)}), while the full answer finished ${totalsPhrase(streamed.s.end, buffered.s.end)} (${fmtMs(streamed.s.end)} against ${fmtMs(buffered.s.end)}).`);
  }
  if (ok(hit) && ok(cold)) parts.push(`The repeated question came back from the response cache in ${fmtMs(hit.s.end)}, against ${fmtMs(cold.s.end)} the first time.`);
  const auto = get('auto');
  if (ok(auto)) parts.push(`The adaptive gateway showed its first token in ${fmtMs(auto.s.ttft)} and finished in ${fmtMs(auto.s.end)}: ${traceBadges(auto.s.done).map((b) => b.text).join('; ') || 'served by the model'}.`);
  const failed = runs.filter((r) => r.s.status === 'error').length;
  if (failed) parts.push(`${failed} lane${failed > 1 ? 's' : ''} failed; the reason is shown on each.`);
  parts.push('One race is a single sample. The statistics are in the benchmark results.');
  $('#race-summary').textContent = parts.join(' ');
}

// ---------- benchmark results ----------
function renderResults(summary) {
  const body = $('#results-body');
  if (!summary) {
    body.replaceChildren(h('div', { class: 'card' }, h('p', {}, 'No benchmark run has been published yet.'), h('p', { class: 'muted' }, 'This section fills in from a real run of the benchmark harness: every arm, every paired comparison with its 95% interval, and the network baseline. Nothing is shown here until it comes from the real service.')));
    return;
  }
  const metricKey = { value: 'ttft' };
  const chartHost = h('div');
  const draw = () => chartHost.replaceChildren(...resultTables(summary, metricKey.value));
  const radio = (v, label) => [h('input', { type: 'radio', name: 'metric', id: `m-${v}`, value: v, checked: v === metricKey.value }), h('label', { for: `m-${v}` }, label)];
  const ctl = h('div', { class: 'seg-ctl', role: 'radiogroup', 'aria-label': 'Metric' }, ...radio('ttft', 'First token'), ...radio('complete', 'Complete answer'));
  ctl.addEventListener('change', (e) => { metricKey.value = e.target.value; draw(); });
  const i = summary.info;
  body.replaceChildren(
    summary.synthetic ? h('p', { class: 'banner', role: 'alert' }, 'SYNTHETIC DATA: these results came from a mock model and are not measurements.') : null,
    h('p', { class: 'meta' }, `Run ${summary.runId} from ${summary.vantage}. ${i.requests} measured requests, ${i.failed} failed, ${i.rounds} rounds after ${i.warmup} warm-up. Repository commit ${i.commit}.`),
    ctl, chartHost);
  draw();
}

function resultTables(summary, key) {
  const metric = `${key}_ms`;
  const sections = [];

  // paired speedups
  const comps = summary.comparisons.filter((c) => c.metric === metric);
  const { min, max, ticks } = SPEEDUP_RANGE, X0 = 10, X1 = 290, px = (x) => X0 + x * (X1 - X0);
  const header = h('svg', { class: 'chart', viewBox: '0 0 300 26', 'aria-hidden': 'true' }, ticks.map((t) => h('text', { class: 'tick', x: px(speedupX(t).x), y: 18, 'text-anchor': 'middle' }, `${t}x`)));
  const rows = comps.map((c) => {
    const p = speedupX(c.point), lo = speedupX(c.lo), hi = speedupX(c.hi), v = verdictOf(c);
    const chart = h('svg', { class: 'chart', viewBox: '0 0 300 26', 'aria-hidden': 'true' },
      ticks.map((t) => h('line', { class: t === 1 ? 'one' : 'grid', x1: px(speedupX(t).x), x2: px(speedupX(t).x), y1: 3, y2: 23 })),
      h('line', { class: `whisker ${v}`, x1: px(lo.x), x2: px(hi.x), y1: 13, y2: 13 }),
      h('circle', { class: `dot ${v}`, cx: px(p.x), cy: 13, r: 5 }));
    return h('tr', {},
      h('td', {}, c.name, h('span', { class: 'sub' }, `${c.a} → ${c.b}`)),
      h('td', { class: 'num' }, c.n),
      h('td', { class: 'num' }, `${fmtMs(c.medianA)} → ${fmtMs(c.medianB)}`),
      h('td', { class: 'num' }, c.saved ? `${fmtMs(c.saved.point)} (${fmtMs(c.saved.lo)} to ${fmtMs(c.saved.hi)})` : 'n/a'),
      h('td', { class: 'num' }, `${fmtRatio(c.point)} (${fmtRatio(c.lo)} to ${fmtRatio(c.hi)})`),
      h('td', {}, chart),
      h('td', {}, h('span', { class: `verdict ${v}` }, v === 'faster' ? 'Faster' : v === 'slower' ? 'Slower' : 'Unclear')));
  });
  sections.push(h('h3', {}, `Paired comparisons: ${key === 'ttft' ? 'time to first token' : 'time to complete answer'}`),
    h('p', { class: 'muted' }, 'Each row changes one setting and compares the same question in the same round. Right of 1x means the second setup was faster. The line is the 95% interval.'),
    h('div', { class: 'card scroll', role: 'region', tabindex: 0, 'aria-label': 'Paired comparisons table' },
      h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Lever'), h('th', { class: 'num' }, 'Pairs'), h('th', { class: 'num' }, 'Median'), h('th', { class: 'num' }, 'Time saved (95% CI)'), h('th', { class: 'num' }, 'Speedup (95% CI)'), h('th', {}, header), h('th', {}, 'Verdict'))), h('tbody', {}, rows))));

  // per-arm latency
  const scale = latencyScale(summary.arms, key);
  const armRows = summary.arms.map((a) => {
    const s = a[key], pct = (v) => `${Math.min(100, (100 * v) / scale)}%`;
    const fill = h('span', { class: 'fill' }), tick = s.p95 != null ? h('span', { class: 'p95', title: '95th percentile' }) : null;
    fill.style.width = pct(s.p50 ?? 0);
    if (tick) tick.style.left = pct(s.p95);
    return h('tr', {},
      h('td', {}, a.attempt > 1 ? `${a.arm} (repeat)` : a.arm, h('span', { class: 'sub' }, `${a.model} · ${a.endpoint} · ${a.flags}`)),
      h('td', { class: 'num' }, `${a.ok}/${a.requests}`),
      h('td', {}, h('div', { class: 'bar' }, fill, tick)),
      h('td', { class: 'num' }, fmtMs(s.p50)), h('td', { class: 'num' }, s.p95 == null ? 'n/a' : fmtMs(s.p95)),
      h('td', { class: 'num' }, a.correct?.graded ? `${a.correct.right}/${a.correct.graded}` : 'n/a'),
      h('td', {}, Object.entries(a.sources ?? {}).map(([k, n]) => `${k} ${n}`).join(', ') || 'n/a'));
  });
  sections.push(h('h3', {}, 'Every setup, side by side'),
    h('p', { class: 'muted' }, 'Bar = median, black tick = 95th percentile (blank when there are fewer than 20 samples).'),
    h('div', { class: 'card scroll', role: 'region', tabindex: 0, 'aria-label': 'Per-setup latency table' },
      h('table', {}, h('thead', {}, h('tr', {}, ...['Setup', 'OK', 'Latency'].map((t, i) => h('th', { class: i === 1 ? 'num' : '' }, t)), h('th', { class: 'num' }, 'Median'), h('th', { class: 'num' }, 'p95'), h('th', { class: 'num' }, 'Answers correct'), h('th', {}, 'Served by'))), h('tbody', {}, armRows))));

  // paraphrase cache: what it served, and above all what it wrongly served
  if (summary.semantic?.length) {
    sections.push(h('h3', {}, 'Paraphrase cache'), h('p', { class: 'muted' }, 'A reworded question should come from the cache. A question that only looks similar (a different number, day, qualifier or negation) must never, because that would be a wrong answer. The cache is built to prefer a miss.'),
      h('div', { class: 'card scroll', role: 'region', tabindex: 0, 'aria-label': 'Paraphrase cache table' },
        h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Setup'), h('th', { class: 'num' }, 'Rewordings served'), h('th', { class: 'num' }, 'False hits'))),
          h('tbody', {}, summary.semantic.map((s) => h('tr', {}, h('td', {}, s.arm), h('td', { class: 'num' }, `${s.paraphrase.hits}/${s.paraphrase.total}`), h('td', { class: 'num' }, `${s.nearmiss.hits}/${s.nearmiss.total}`)))))));
  }

  // network baseline
  if (summary.network?.length) {
    sections.push(h('h3', {}, 'Network baseline'), h('p', { class: 'muted' }, 'A request with no model involved: the floor for each region. Connection setup medians are over new connections only.'),
      h('div', { class: 'card scroll', role: 'region', tabindex: 0, 'aria-label': 'Network baseline table' },
        h('table', {}, h('thead', {}, h('tr', {}, ...['Endpoint', 'Connection'].map((t) => h('th', {}, t)), ...['DNS', 'TCP', 'TLS', 'Round trip p50'].map((t) => h('th', { class: 'num' }, t)))),
          h('tbody', {}, summary.network.map((n) => h('tr', {}, h('td', {}, n.endpoint), h('td', {}, n.fresh ? 'new connection' : 'kept alive'), ...[n.dns, n.tcp, n.tls, n.p50].map((v) => h('td', { class: 'num' }, fmtMs(v)))))))));
  }
  if (summary.warnings?.length) sections.push(h('h3', {}, 'Data quality notes'), h('ul', { class: 'warnings' }, summary.warnings.map((w) => h('li', {}, w))));
  return sections;
}

boot();
