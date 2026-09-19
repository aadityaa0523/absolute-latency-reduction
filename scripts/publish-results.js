// Copies a finished run's summary to web/results.json so the demo page shows it.
// Refuses synthetic runs: mock-model numbers must never reach the public page.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
if (!dir) { console.error('usage: node scripts/publish-results.js results/<run>'); process.exit(2); }
const summary = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8'));
if (summary.synthetic) { console.error('refusing to publish: this run contains mock-model data'); process.exit(1); }
if (!summary.comparisons?.length) { console.error('refusing to publish: the run has no paired comparisons'); process.exit(1); }
writeFileSync('web/results.json', JSON.stringify(summary, null, 2) + '\n');
console.log(`published run ${summary.runId} to web/results.json (${summary.info.requests} requests, ${summary.info.failed} failed)`);
