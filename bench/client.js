// Measures one request from the client's side: DNS, TCP and TLS setup, time to first byte, time to the first
// real model token, and completion. Uses node:http(s) rather than fetch so connection setup is observable.
import http from 'node:http';
import https from 'node:https';

const warm = { 'http:': new http.Agent({ keepAlive: true }), 'https:': new https.Agent({ keepAlive: true }) };

export function call({ url, method = 'POST', body, fresh = false, timeoutMs = 60000, clock = () => performance.now() }) {
  return new Promise((resolve) => {
    const u = new URL(url), lib = u.protocol === 'https:' ? https : http;
    const agent = fresh ? new lib.Agent({ keepAlive: false }) : warm[u.protocol];
    const t0 = clock();
    const rec = { ok: false, status: null, reused: false, dns_ms: 0, tcp_ms: 0, tls_ms: 0, headers_ms: null, ttfb_ms: null, ttft_ms: null, complete_ms: null, end_ms: null, done: null, error: null };
    let finished = false;
    const finish = () => { if (finished) return; finished = true; if (fresh) agent.destroy(); resolve(rec); };
    const fail = (name, message) => { rec.error ??= { code: 'network', name, message }; rec.end_ms ??= clock() - t0; finish(); };

    const onLine = (line, now) => {
      let ev;
      try { ev = JSON.parse(line); } catch { return; }
      if (ev.t === 'token' && rec.ttft_ms === null) rec.ttft_ms = now;
      else if (ev.t === 'done') { rec.done = ev; rec.complete_ms = now; }
      else if (ev.t === 'error') { rec.error = ev; rec.complete_ms = now; }
      else if (ev.ok === true && ev.t === undefined) { rec.done = { route: 'ping', ...ev }; rec.complete_ms = now; }
    };

    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = lib.request(u, {
      method, agent,
      headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {},
    }, (res) => {
      rec.status = res.statusCode;
      rec.headers_ms = clock() - t0;
      res.setEncoding('utf8');
      let buf = '';
      res.on('data', (chunk) => {
        const now = clock() - t0;
        rec.ttfb_ms ??= now;
        buf += chunk;
        for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          if (line) onLine(line, now);
        }
      });
      res.on('end', () => {
        rec.end_ms = clock() - t0;
        if (buf.trim()) onLine(buf, rec.end_ms);
        rec.ok = rec.status === 200 && rec.error === null && rec.done !== null;
        if (!rec.ok && rec.error === null) rec.error = { code: 'http', name: `HTTP${rec.status}`, message: 'no done event' };
        finish();
      });
      res.on('error', (e) => fail(e.code ?? e.name, e.message));
    });
    req.on('socket', (s) => {
      rec.reused = req.reusedSocket === true;
      if (rec.reused) return;
      let prev = clock();
      const lap = (k) => () => { const n = clock(); rec[k] = n - prev; prev = n; };
      s.once('lookup', lap('dns_ms')); s.once('connect', lap('tcp_ms')); s.once('secureConnect', lap('tls_ms'));
    });
    req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error(`no response within ${timeoutMs} ms`), { code: 'ETIMEDOUT' })));
    req.on('error', (e) => fail(e.code ?? e.name, e.message));
    req.end(payload);
  });
}
