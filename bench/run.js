// Runs the comparison. For every round and prompt the arms run in a seeded random order, one request at a
// time, so time-of-day drift and cache warmth are spread across arms instead of favouring one.
import { parseArgs } from 'node:util';
import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { call } from './client.js';
import { rng, shuffled } from './stats.js';
import { MODELS } from '../relay/models.js';
import { loadWorkload } from '../relay/workload.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const safe = (s) => s.replace(/[^A-Za-z0-9_-]/g, '-');

export function validateConfig(cfg) {
  const problems = [], ids = new Set();
  for (const a of cfg.arms ?? []) {
    if (!/^[A-Za-z0-9_-]{1,20}$/.test(a.id ?? '')) problems.push(`arm id "${a.id}" must be 1-20 chars of [A-Za-z0-9_-]`);
    if (ids.has(a.id)) problems.push(`duplicate arm id ${a.id}`);
    ids.add(a.id);
    if (!cfg.endpoints?.[a.endpoint]) problems.push(`arm ${a.id}: unknown endpoint "${a.endpoint}"`);
    if (a.kind !== 'ping' && !a.auto && !Object.hasOwn(MODELS, a.model)) problems.push(`arm ${a.id}: unknown model "${a.model}"`);
    if (a.salt !== undefined && !['nonce', 'run'].includes(a.salt)) problems.push(`arm ${a.id}: salt must be "nonce" or "run"`);
  }
  for (const c of cfg.comparisons ?? []) {
    for (const k of ['a', 'b']) if (!ids.has(c[k])) problems.push(`comparison "${c.name}": unknown arm "${c[k]}"`);
  }
  if (!ids.size) problems.push('no arms defined');
  return problems;
}

export async function runBenchmark({ config, workload, rounds, warmup, seed, vantage, outDir, pauseMs = 250, runId, strata, callImpl = call, log = () => {} }) {
  const problems = validateConfig(config);
  if (problems.length) throw new Error(`invalid arms config:\n- ${problems.join('\n- ')}`);
  const next = rng(seed);
  const prompts = [...workload.prompts.values()].filter((p) => strata.includes(p.stratum));
  if (!prompts.length) throw new Error(`no prompts in strata ${strata.join(',')}`);
  if (config.arms.some((a) => a.seed)) {
    const orphan = prompts.find((p) => p.base && !workload.prompts.has(p.base));
    if (orphan) throw new Error(`prompt ${orphan.id} rewords ${orphan.base}, which is not in the workload, so it cannot be seeded`);
  }
  const pingArms = config.arms.filter((a) => a.kind === 'ping'), modelArms = config.arms.filter((a) => a.kind !== 'ping');

  await mkdir(outDir, { recursive: true });
  const rawPath = join(outDir, 'raw.jsonl');
  await writeFile(rawPath, '');
  let commit = 'unknown';
  try { commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* not a repo */ }
  await writeFile(join(outDir, 'meta.json'), JSON.stringify({
    runId, startedAt: new Date().toISOString(), vantage, node: process.version, commit, seed, rounds, warmup, strata, pauseMs,
    endpoints: config.endpoints, arms: config.arms, comparisons: config.comparisons ?? [], handbookVersion: workload.handbookVersion,
  }, null, 2));

  let nonce = 0, count = 0;
  const record = async (row) => { await appendFile(rawPath, JSON.stringify(row) + '\n'); count++; };
  for (let round = 0; round < warmup + rounds; round++) {
    const isWarmup = round < warmup;
    for (const arm of shuffled(pingArms, next)) {
      const r = await callImpl({ url: new URL('health', config.endpoints[arm.endpoint]).href, method: 'GET', fresh: !!arm.fresh });
      await record({ run: runId, round, warmup: isWarmup, promptId: null, stratum: 'ping', arm: arm.id, attempt: 1, ...r });
      await sleep(pauseMs);
    }
    for (const prompt of shuffled(prompts, next)) {
      for (const arm of shuffled(modelArms, next)) {
        // One cache namespace per round, arm and measured question: an arm's cached answers can never serve another arm,
        // and a paraphrase's seed request cannot turn the base question's own measurement into a cache hit.
        // Keep the tail (arm and question ids) if it must be shortened, so distinct measurements never share a namespace.
        const namespace = safe(`${runId}-${round}-${arm.id}-${prompt.id}`).slice(-40);
        const bodyFor = (p) => {
          const common = {
            promptId: p.id, stream: arm.stream ?? true, maxTokens: arm.maxTokens ?? 200, namespace,
            // Cold prefix by default: a fresh salt per request, so no arm can benefit from a cache by accident.
            // Only an arm that sets salt "run" shares one prefix across the run, which is how prompt caching is tested.
            prefixSalt: arm.salt === 'run' ? safe(`${runId}-${arm.id}`).slice(0, 40) : safe(`n${++nonce}-${runId}`).slice(0, 40),
          };
          return arm.auto
            ? { ...common, auto: true, responseCache: arm.responseCache ?? true, semanticCache: arm.semanticCache ?? true, fallback: arm.fallback ?? true, budgetMs: arm.budgetMs }
            : { ...common, model: arm.model, responseCache: !!arm.responseCache, promptCache: !!arm.promptCache };
        };
        // A paraphrase or near-miss is only meaningful after the question it rewords has been asked, so seed it first.
        // The seed request is recorded (seed: true) but excluded from every statistic.
        if (arm.seed && prompt.base) {
          const seedPrompt = workload.prompts.get(prompt.base);
          const r = await callImpl({ url: config.endpoints[arm.endpoint], body: bodyFor(seedPrompt), fresh: !!arm.fresh });
          await record({ run: runId, round, warmup: isWarmup, seed: true, promptId: seedPrompt.id, stratum: seedPrompt.stratum, arm: arm.id, attempt: 0, ...r, text: undefined });
          await sleep(pauseMs);
        }
        for (let attempt = 1; attempt <= (arm.repeat ?? 1); attempt++) {
          const r = await callImpl({ url: config.endpoints[arm.endpoint], body: bodyFor(prompt), fresh: !!arm.fresh });
          // Keyed correctness: a handbook question has a known answer, so a fast answer is only good if it is also right.
          const correct = prompt.expect && r.ok ? prompt.expect.every((e) => new RegExp(e, 'i').test(r.text)) : null;
          await record({ run: runId, round, warmup: isWarmup, promptId: prompt.id, stratum: prompt.stratum, arm: arm.id, attempt, ...r, correct, text: r.text?.slice(0, 600) });
          await sleep(pauseMs);
        }
      }
    }
    log(`round ${round + 1}/${warmup + rounds}${isWarmup ? ' (warmup)' : ''} done, ${count} requests`);
  }
  return { rawPath, count };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values: v } = parseArgs({ options: {
    arms: { type: 'string' }, rounds: { type: 'string', default: '5' }, warmup: { type: 'string', default: '1' },
    seed: { type: 'string', default: '42' }, vantage: { type: 'string' }, strata: { type: 'string', default: 'short,handbook,long' },
    'pause-ms': { type: 'string', default: '250' }, out: { type: 'string' }, 'run-id': { type: 'string' },
  } });
  if (!v.arms || !v.vantage) { console.error('usage: node bench/run.js --arms <file.json> --vantage "<city, network>" [--rounds 5 --warmup 1 --seed 42 --strata short,handbook,long --out results/<id>]'); process.exit(2); }
  const runId = v['run-id'] ?? new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  const config = JSON.parse(await readFile(v.arms, 'utf8'));
  const out = v.out ?? join('results', runId);
  const { rawPath, count } = await runBenchmark({
    config, workload: await loadWorkload(), rounds: +v.rounds, warmup: +v.warmup, seed: +v.seed, vantage: v.vantage,
    outDir: out, pauseMs: +v['pause-ms'], runId, strata: v.strata.split(','), log: console.log,
  });
  console.log(`wrote ${count} records to ${rawPath}\nnext: node bench/report.js ${out}`);
}
