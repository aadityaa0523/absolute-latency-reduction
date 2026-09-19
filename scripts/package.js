// Builds build/relay.zip: the relay code, the fixed workload it serves, and package.json (needed for ES modules).
// The AWS SDK v3 ships with the Lambda Node.js runtime, so nothing is bundled.
import { mkdirSync, rmSync, cpSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const stage = 'build/stage', zip = 'build/relay.zip';
rmSync('build', { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
cpSync('relay', `${stage}/relay`, { recursive: true, filter: (p) => !p.endsWith('local.js') });
cpSync('workload', `${stage}/workload`, { recursive: true });
copyFileSync('package.json', `${stage}/package.json`);
// Windows 10+ ships bsdtar, which writes zip when asked with -a.
execFileSync('tar', ['-a', '-c', '-f', zip, '-C', stage, '.'], { stdio: 'inherit' });
const sha = createHash('sha256').update(readFileSync(zip)).digest('hex').slice(0, 12);
console.log(`built ${zip} (sha256 ${sha})`);
