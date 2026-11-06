#!/usr/bin/env node
/**
 * scripts/e2e-live.mjs — smoke na ŻYWO: prawdziwa Obscura + prawdziwa sieć.
 *
 * Nie wchodzi do domyślnych testów (wymaga binarii i internetu):
 *   OBSCURA_BIN=bin/obscura.exe node scripts/e2e-live.mjs "PHP 8.4 release"
 *
 * Sprawdza całą syntezę end-to-end:
 *   1. web.search  → engine (fetch, resolve, falsify, learn)
 *   2. web.search  → auto-render strony JS-owej przez V8 (jeśli binaria jest)
 *   3. web.render  → jawny render jednego URL
 *   4. web.stats   → wnętrze (cache/prior/drift)
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dir, '..', 'src', 'mcp', 'server.mjs');
const QUERY = process.argv[2] || 'PHP 8.4 release announcement changelog';

const child = spawn(process.execPath, [SERVER], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: { ...process.env, WEB_RENDER: 'auto' },
});

const rl = createInterface({ input: child.stdout });
const pending = new Map();
let nextId = 1;
rl.on('line', (line) => {
  line = line.trim();
  if (!line) return;
  try {
    const msg = JSON.parse(line);
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, timer } = pending.get(msg.id);
      clearTimeout(timer);
      pending.delete(msg.id);
      resolve(msg);
    }
  } catch {}
});

function send(method, params, timeoutMs = 60000) {
  const id = nextId++;
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} })}\n`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout ${method}`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
  });
}

function step(name, ok, detail) {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` :: ${String(detail).slice(0, 220)}` : ''}`);
  return ok;
}

(async () => {
  let ok = true;
  const t0 = Date.now();
  try {
    await send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e-live', version: '1.0.0' } });
    send('notifications/initialized', {});

    const list = await send('tools/list', {});
    const names = list.result.tools.map((t) => t.name);
    ok = step('tools/list', names.includes('web.search') && names.some((n) => n.startsWith('browser_')), `${names.length} narzędzi (web.* + browser_*)`);

    const cfg = await send('tools/call', { name: 'web.configure', arguments: {} });
    ok = step('web.configure', !cfg.result.isError, JSON.parse(cfg.result.content[0].text).renderer);

    const search = await send('tools/call', { name: 'web.search', arguments: { query: QUERY, urls: ['https://www.php.net/releases/8.4/en.php'], top: 3 } });
    const data = search.result.isError ? {} : JSON.parse(search.result.content[0].text);
    ok = step('web.search', !search.result.isError && data.ok === true && Array.isArray(data.results),
      `coverage ${data.coverage} · results ${data.results?.length} · requests ${data.stats?.requests} · renders ${data.stats?.renders} · ${data.stats?.ms} ms`);

    const render = await send('tools/call', { name: 'web.render', arguments: { url: 'https://example.com' } });
    const rdata = render.result.isError ? {} : JSON.parse(render.result.content[0].text);
    ok = step('web.render (V8)', !render.result.isError && rdata.ok === true, `title "${rdata.title}" · ${rdata.length} znaków`);

    const stats = await send('tools/call', { name: 'web.stats', arguments: {} });
    ok = step('web.stats', !stats.result.isError, JSON.stringify(JSON.parse(stats.result.content[0].text).prior?.entries ?? 0) + ' wpisów priora');
  } catch (e) {
    ok = step('exception', false, String(e));
  } finally {
    child.kill();
    console.log(`\nczas: ${Date.now() - t0} ms`);
    process.exit(ok ? 0 : 1);
  }
})();
