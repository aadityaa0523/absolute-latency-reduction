import { readFile } from 'node:fs/promises';

// The relay serves its own demo page, so the public URL needs no CloudFront or bucket.
// Only files in this table can be served, so there is no path-traversal surface.
const FILES = {
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/lib.js': ['lib.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/config.json': ['config.json', 'application/json; charset=utf-8'],
  '/results.json': ['results.json', 'application/json; charset=utf-8'],
};

const CSP = [
  "default-src 'none'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:",
  "connect-src 'self' https://*.on.aws http://127.0.0.1:* http://localhost:*",
  "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
].join('; ');

const here = (p) => new URL(p, import.meta.url);

// Returns Map(path -> {headers, body}). results.json is optional: absent until a real benchmark run is published.
export async function loadWeb({ resultsFile } = {}) {
  const web = new Map();
  for (const [path, [file, type]] of Object.entries(FILES)) {
    let body;
    try {
      body = await readFile(path === '/results.json' && resultsFile ? resultsFile : here(`../web/${file}`), 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT' && path === '/results.json') continue;
      throw e;
    }
    web.set(path, {
      body,
      headers: {
        'content-type': type, 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
        ...(type.startsWith('text/html') ? { 'content-security-policy': CSP } : {}),
      },
    });
  }
  return web;
}
