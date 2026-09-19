import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const here = (p) => new URL(p, import.meta.url);

export async function loadWorkload() {
  const handbook = await readFile(here('../workload/handbook.txt'), 'utf8');
  const lines = (await readFile(here('../workload/prompts.jsonl'), 'utf8')).split('\n').filter(Boolean);
  const prompts = new Map(lines.map((l) => JSON.parse(l)).map((p) => [p.id, p]));
  return { handbook, handbookVersion: createHash('sha256').update(handbook).digest('hex').slice(0, 12), prompts };
}
