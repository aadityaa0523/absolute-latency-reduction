// Turns raw.jsonl + meta.json into report.md and summary.json. Every claim in the report is computed here
// from the raw records; nothing is typed in by hand.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarize, pairedSpeedup, median } from './stats.js';

const f = (x, d = 0) => (x == null || !Number.isFinite(x) ? 'n/a' : x.toFixed(d));
const table = (head, rows) => [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(0)}%` : 'n/a');
const outTokens = (r) => r.done?.usage?.outputTokens ?? null;

// Output tokens per second on the decode phase only, matching the AWS definition (tokens over latency minus TTFT).
// Only meaningful when a model streamed the answer; a cache hit delivers every token at once.
const otps = (r) => {
  const n = outTokens(r), span = r.complete_ms - r.ttft_ms;
  return r.done?.route === 'model' && n > 1 && span > 0 ? (n / span) * 1000 : null;
};

export function buildReport(records, meta) {
  const synthetic = records.some((r) => r.done?.provider === 'mock');
  const measured = records.filter((r) => !r.warmup);
  const ok = (r) => r.ok;
  const armsById = new Map(meta.arms.map((a) => [a.id, a]));
  const out = [];

  out.push(`# Latency comparison report: run ${meta.runId}`, '');
  if (synthetic) out.push('> **SYNTHETIC DATA.** This run contains responses from the mock provider. It is a test of the harness, not a measurement of AWS or Bedrock. Do not quote any number below.', '');
  out.push(table(['Field', 'Value'], [
    ['Started', meta.startedAt], ['Client vantage', meta.vantage], ['Node', meta.node], ['Repo commit', meta.commit],
    ['Rounds measured / warmup', `${meta.rounds} / ${meta.warmup} (warmup rounds are excluded)`], ['Seed', meta.seed],
    ['Strata', meta.strata.join(', ')], ['Handbook version', meta.handbookVersion],
    ['Endpoints', Object.entries(meta.endpoints).map(([k, u]) => `${k}: ${u}`).join('<br>')],
  ]), '');
  out.push('Method: one request at a time; arm order shuffled per prompt per round with the run seed; the SDK does not retry, so throttling shows as errors, not as hidden latency. TTFT is the time until the first real model token arrives at the client, not the first byte. p95 is shown only with at least 20 samples and p99 with at least 100; otherwise it is the maximum in disguise and is left blank.', '');

  // Per-arm summary
  const modelRows = [], summaryArms = [];
  for (const arm of meta.arms.filter((a) => a.kind !== 'ping')) {
    const mine = measured.filter((r) => r.arm === arm.id);
    for (const attempt of [...new Set(mine.map((r) => r.attempt))].sort()) {
      const rs = mine.filter((r) => r.attempt === attempt), good = rs.filter(ok);
      const ttft = summarize(good.map((r) => r.ttft_ms)), done = summarize(good.map((r) => r.complete_ms));
      const flags = [arm.stream === false ? 'buffered' : 'streamed', arm.promptCache && 'prompt-cache', arm.responseCache && 'response-cache'].filter(Boolean).join(' + ');
      const row = {
        arm: arm.id, attempt, endpoint: arm.endpoint, model: arm.model, flags, requests: rs.length, ok: good.length,
        ttft, complete: done, otps: median(good.filter(() => arm.stream !== false).map(otps).filter(Number.isFinite)),
        outTokens: median(good.map(outTokens).filter(Number.isFinite)),
        promptCacheHit: good.filter((r) => r.done.usage?.cacheReadInputTokens > 0).length / (good.length || 1),
        responseCacheHit: good.filter((r) => r.done.cache === 'hit').length / (good.length || 1),
      };
      summaryArms.push(row);
      modelRows.push([arm.id, attempt, arm.endpoint, arm.model, flags, `${good.length}/${rs.length}`, f(ttft.p50), f(ttft.p95), f(ttft.p99), f(done.p50), f(done.p95), f(done.p99),
        f(row.otps, 1), f(row.outTokens), pct(good.filter((r) => r.done.usage?.cacheReadInputTokens > 0).length, good.length), pct(good.filter((r) => r.done.cache === 'hit').length, good.length)]);
    }
  }
  out.push('## Per-arm results (milliseconds)', '', 'Attempt 2 exists only for arms that repeat the same request, to measure a response-cache hit.', '');
  out.push(table(['Arm', 'Try', 'Endpoint', 'Model', 'Mode', 'OK', 'TTFT p50', 'p95', 'p99', 'Done p50', 'p95', 'p99', 'OTPS', 'Out tok', 'Prompt-cache read', 'Resp-cache hit'], modelRows), '');

  // Network table from ping arms
  const pingRows = [], network = [];
  for (const arm of meta.arms.filter((a) => a.kind === 'ping')) {
    const good = measured.filter((r) => r.arm === arm.id && ok(r)), fresh = good.filter((r) => !r.reused);
    const t = summarize(good.map((r) => r.complete_ms));
    const dns = median(fresh.map((r) => r.dns_ms)), tcp = median(fresh.map((r) => r.tcp_ms)), tls = median(fresh.map((r) => r.tls_ms));
    network.push({ arm: arm.id, endpoint: arm.endpoint, fresh: !!arm.fresh, n: good.length, dns, tcp, tls, p50: t.p50, p95: t.p95 });
    pingRows.push([arm.id, arm.endpoint, arm.fresh ? 'new connection' : 'kept alive', `${good.length}`, f(dns), f(tcp), f(tls), f(t.p50), f(t.p95)]);
  }
  if (pingRows.length) out.push('## Network baseline (GET, no model involved)', '', 'This is the floor for each endpoint: connection setup plus one Lambda invocation. DNS, TCP and TLS are medians over new connections only.', '', table(['Arm', 'Endpoint', 'Connection', 'n', 'DNS', 'TCP', 'TLS', 'Round trip p50', 'p95'], pingRows), '');

  // Paired comparisons
  const compRows = [], summaryComps = [], warnings = [];
  for (const c of meta.comparisons) {
    const pick = (arm, attempt) => new Map(measured.filter((r) => r.arm === arm && r.attempt === attempt && ok(r) && (!c.strata || c.strata.includes(r.stratum))).map((r) => [`${r.round}|${r.promptId}`, r]));
    const A = pick(c.a, c.aAttempt ?? 1), B = pick(c.b, c.bAttempt ?? 1);
    const keys = [...A.keys()].filter((k) => B.has(k));
    const label = `${c.a}${c.aAttempt > 1 ? `#${c.aAttempt}` : ''} -> ${c.b}${c.bAttempt > 1 ? `#${c.bAttempt}` : ''}`;
    for (const metric of ['ttft_ms', 'complete_ms']) {
      if (keys.length < 5) { compRows.push([c.name, label, metric.replace('_ms', ''), `${keys.length}`, 'n/a', 'n/a', 'n/a', 'too few pairs to conclude']); continue; }
      const a = keys.map((k) => A.get(k)[metric]), b = keys.map((k) => B.get(k)[metric]);
      const s = pairedSpeedup(a, b, { seed: meta.seed });
      const verdict = s.lo > 1 ? 'second is faster' : s.hi < 1 ? 'second is slower' : 'no clear difference';
      compRows.push([c.name, label, metric.replace('_ms', ''), `${s.n}`, f(median(a)), f(median(b)), `${f(s.point, 2)}x (${f(s.lo, 2)} to ${f(s.hi, 2)})`, verdict]);
      summaryComps.push({ name: c.name, a: c.a, b: c.b, metric, ...s, medianA: median(a), medianB: median(b), verdict });
    }
    const ta = median(keys.map((k) => outTokens(A.get(k))).filter(Number.isFinite)), tb = median(keys.map((k) => outTokens(B.get(k))).filter(Number.isFinite));
    if (Number.isFinite(ta) && Number.isFinite(tb) && Math.abs(ta - tb) / Math.max(ta, tb) > 0.25) warnings.push(`"${c.name}": median output length differs (${f(ta)} vs ${f(tb)} tokens), so completion time is not comparable; use OTPS.`);
  }
  out.push('## Paired comparisons', '', 'Each row compares two arms on the same prompt in the same round. Speedup is median(first) / median(second) with a 95% bootstrap interval over pairs; above 1 means the second arm is faster. "No clear difference" means the interval includes 1.', '', table(['Lever', 'Comparison', 'Metric', 'Pairs', 'Median first', 'Median second', 'Speedup (95% CI)', 'Verdict'], compRows), '');

  // Data quality
  for (const arm of meta.arms.filter((a) => a.kind !== 'ping' && !a.promptCache)) {
    const leaked = measured.filter((r) => r.arm === arm.id && ok(r) && r.done.usage?.cacheReadInputTokens > 0).length;
    if (leaked) warnings.push(`Arm ${arm.id} has prompt-cache off but ${leaked} request(s) read from a cache; it is not a clean control.`);
  }
  const errs = new Map();
  for (const r of measured.filter((x) => !ok(x))) { const k = `${r.arm}: ${r.error?.name ?? 'unknown'}${r.error?.message ? ` (${r.error.message.slice(0, 90)})` : ''}`; errs.set(k, (errs.get(k) ?? 0) + 1); }
  out.push('## Data quality', '');
  out.push(`Measured requests: ${measured.length}; failed: ${measured.filter((r) => !ok(r)).length}. Failed requests are excluded from latency statistics and are never retried.`, '');
  if (errs.size) out.push(table(['Failure', 'Count'], [...errs].sort((x, y) => y[1] - x[1]).slice(0, 10).map(([k, n]) => [k, n])), '');
  for (const w of warnings) out.push(`- Warning: ${w}`);
  out.push('', '## Limits', '', '- One client vantage per run; results describe that network path, not India as a whole.', '- Bedrock capacity varies with time of day; compare arms only within a run.', '- Latency percentiles are descriptive of this sample, not a guarantee.');
  const info = { startedAt: meta.startedAt, rounds: meta.rounds, warmup: meta.warmup, commit: meta.commit, strata: meta.strata, requests: measured.length, failed: measured.filter((r) => !ok(r)).length };
  return { markdown: out.join('\n') + '\n', summary: { runId: meta.runId, synthetic, vantage: meta.vantage, info, arms: summaryArms, network, comparisons: summaryComps, warnings } };
}

export async function reportDir(dir) {
  const meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8'));
  const records = (await readFile(join(dir, 'raw.jsonl'), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const { markdown, summary } = buildReport(records, meta);
  await writeFile(join(dir, 'report.md'), markdown);
  await writeFile(join(dir, 'summary.json'), JSON.stringify(summary, null, 2));
  return { markdown, summary };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) { console.error('usage: node bench/report.js results/<run>'); process.exit(2); }
  await reportDir(process.argv[2]);
  console.log(`wrote ${join(process.argv[2], 'report.md')} and summary.json`);
}
