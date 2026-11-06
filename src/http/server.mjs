#!/usr/bin/env node
/**
 * http/server.mjs — lokalny serwer HTTP dla silnika (sandbox, klienci, debug).
 *
 * Jeden silnik, trzy wejścia — tuti trzecie: REST. Ten sam kod, ten sam cache
 * i prior co MCP i CLI. Domyślnie nasłuchuje TYLKO na loopbacku (silnik nie
 * jest usługą publiczną; publiczne APIrob jest na stronie/operatorze).
 *
 *   WEB_HTTP_HOST (127.0.0.1) · WEB_HTTP_PORT (8787) · WEB_API_KEY (opcjonalny)
 *   rate limit prosty: WEB_RATE_LIMIT zapytań / 60 s na IP (domyślnie 60)
 *
 * Trasy (JSON in/out):
 *   POST   /web/search  /web/trace  /web/brief  /web/verify_links
 *          /web/drift_report      /web/render  /web/feedback  /web/feeds
 *   GET    /web/stats   /web/drift  /web/config /web/cache  /web/eval
 *   POST   /web/cache                                     /web/eval
 */
import { createServer } from 'node:http';

import { AiSearchInstance } from '../engine/instance.mjs';

const engine = AiSearchInstance.withOptionalRenderer();

const HOST = process.env.WEB_HTTP_HOST || '127.0.0.1';
const PORT = Number(process.env.WEB_HTTP_PORT || 8787);
const API_KEY = process.env.WEB_API_KEY || '';
const RATE_LIMIT = Number(process.env.WEB_RATE_LIMIT || 60);

const buckets = new Map(); // ip → { n, resetAt }
function rateLimited(ip) {
  const now = Date.now();
  const b = buckets.get(ip) || { n: 0, resetAt: now + 60000 };
  if (now > b.resetAt) {
    b.n = 0;
    b.resetAt = now + 60000;
  }
  b.n += 1;
  buckets.set(ip, b);
  return b.n > RATE_LIMIT;
}

const json = (res, code, obj) => {
  const body = JSON.stringify(obj, null, 1);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
};

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { __parseError: text.slice(0, 200) };
  }
}

const ROUTES = {
  'POST /web/search': (i, b) => i.search(b),
  'POST /web/trace': (i, b) => i.trace(b),
  'POST /web/brief': (i, b) => i.brief(b),
  'POST /web/verify_links': (i, b) => i.verifyLinks(b),
  'POST /web/drift_report': (i, b) => i.driftReport(b),
  'POST /web/render': (i, b) => i.render(b),
  'POST /web/feedback': (i, b) => i.feedback(b),
  'POST /web/feeds': (i, b) => i.feeds(b),
  'GET /web/stats': (i) => i.stats(),
  'GET /web/drift': (i) => i.drift({}),
  'GET /web/config': (i) => i.configure(),
  'GET /web/cache': (i) => i.cache({}),
  'GET /web/eval': (i, b) => i.eval(b),
  'POST /web/cache': (i, b) => i.cache(b),
  'POST /web/eval': (i, b) => i.eval(b),
};

const server = createServer(async (req, res) => {
  const ip = req.socket.remoteAddress || '?';
  try {
    if (rateLimited(ip)) return json(res, 429, { ok: false, error: 'rate limit (zapytań/minutę)' });
    if (API_KEY) {
      const auth = String(req.headers.authorization || '');
      if (auth !== `Bearer ${API_KEY}`) return json(res, 401, { ok: false, error: 'brak/zły klucz API' });
    }
    const url = new URL(req.url, `http://${HOST}`);
    const key = `${req.method} ${url.pathname}`;
    const handler = ROUTES[key];
    if (!handler) return json(res, 404, { ok: false, error: `nieznana trasa: ${key}`, routes: Object.keys(ROUTES) });
    const body = req.method === 'POST' ? await readBody(req) : Object.fromEntries(url.searchParams);
    if (body.__parseError) return json(res, 400, { ok: false, error: 'niepoprawny JSON', raw: body.__parseError });
    if (key === 'GET /web/drift' || key === 'GET /web/cache' || key === 'GET /web/eval') Object.assign(body, Object.fromEntries(url.searchParams));
    const out = await handler(engine, body);
    json(res, 200, { ok: true, ...out });
  } catch (err) {
    json(res, 500, { ok: false, error: String(err?.message || err).slice(0, 400) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`aisearch HTTP: http://${HOST}:${PORT} (trasy: ${Object.keys(ROUTES).length})`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await engine.close().catch(() => {});
    server.close(() => process.exit(0));
  });
}
