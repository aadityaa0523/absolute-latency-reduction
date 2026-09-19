// Local server with the same request path as Lambda. Defaults to the SYNTHETIC mock provider.
// `node relay/local.js --bedrock` uses real Bedrock with your local AWS credentials (development only).
// `--results <summary.json>` previews the results section of the page with a given benchmark summary.
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { serve } from './serve.js';
import { loadWorkload } from './workload.js';
import { loadWeb } from './web.js';
import { MemoryCache } from './cache.js';
import { mockProvider } from './providers/mock.js';

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET,POST,OPTIONS' };

export async function startLocal({ port = 0, provider = mockProvider(), region = 'local', cache = new MemoryCache(), resultsFile } = {}) {
  const deps = { region, provider, cache, workload: await loadWorkload(), web: await loadWeb({ resultsFile }) };
  const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS).end(); return; }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const sink = {
      head: (status, headers) => res.writeHead(status, { ...headers, ...CORS }),
      write: (s) => res.write(s),
      end: () => res.end(),
    };
    try {
      const path = new URL(req.url, 'http://local').pathname;
      await serve({ method: req.method, path, rawBody: Buffer.concat(chunks).toString('utf8') }, sink, deps);
    } catch (e) {
      console.error(e);
      if (!res.headersSent) res.writeHead(500, CORS);
      res.end();
    }
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/`, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
  let provider = mockProvider();
  if (process.argv.includes('--bedrock')) {
    const { bedrockProvider } = await import('./providers/bedrock.js');
    provider = await bedrockProvider(process.env.AWS_REGION ?? 'ap-south-1');
  }
  const { url } = await startLocal({ port: 8787, provider, region: process.env.AWS_REGION ?? 'local', resultsFile: arg('--results') });
  console.log(`relay and demo page on ${url} (provider: ${provider.name})`);
}
