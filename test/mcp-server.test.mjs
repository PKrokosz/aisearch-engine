/**
 * test/mcp-server.test.mjs — smoke zunifikowanego serwera MCP.
 *
 * Prawdziwy proces `node src/mcp/server.mjs` + atrapa Obscury (stub).
 * Sprawdza: handshake, scalenie listy narzędzi (web.* + browser_*),
 * passthrough przeglądarki, web.render, web.stats offline, obsługę błędów.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const __dir = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dir, '..', 'src', 'mcp', 'server.mjs');
const STUB = join(__dir, 'stub-obscura.mjs');

function startServer(cacheDir) {
  const child = spawn(process.execPath, [SERVER], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, OBSCURA_BIN: STUB, WEB_CACHE_DIR: cacheDir, WEB_RENDER: 'auto' },
  });
  const rl = createInterface({ input: child.stdout });
  const pending = new Map();
  let nextId = 1;
  rl.on('line', (line) => {
    line = line.trim();
    if (!line) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve } = pending.get(msg.id);
      pending.delete(msg.id);
      resolve(msg);
    }
  });
  const send = (method, params) => {
    const id = nextId++;
    const msg = { jsonrpc: '2.0', id, method, params: params || {} };
    child.stdin.write(`${JSON.stringify(msg)}\n`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`timeout ${method}`));
        }
      }, 15000);
      pending.set(id, {
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
  };
  return { child, send, stop: () => child.kill() };
}

test('serwer MCP: handshake + scalone narzędzia web.* i browser_*', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aisearch-mcp-'));
  const { child, send, stop } = startServer(dir);
  try {
    const init = await send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } });
    assert.ok(init.result?.serverInfo?.name === 'aisearch');

    const list = await send('tools/list', {});
    const names = list.result.tools.map((t) => t.name);
    assert.ok(names.includes('web.search'), 'web.search na liście');
    assert.ok(names.includes('web.verify_links'), 'web.verify_links na liście');
    assert.ok(names.includes('web.render'), 'web.render na liście');
    assert.ok(names.includes('browser_navigate'), 'passthrough browser_navigate na liście');
    assert.ok(names.includes('browser_markdown'), 'passthrough browser_markdown na liście');

    const cfg = await send('tools/call', { name: 'web.configure', arguments: {} });
    const cfgData = JSON.parse(cfg.result.content[0].text);
    assert.equal(cfgData.renderer, 'obscura (leniwy)');

    const stats = await send('tools/call', { name: 'web.stats', arguments: {} });
    assert.ok(!stats.result.isError);
    JSON.parse(stats.result.content[0].text);

    const nav = await send('tools/call', { name: 'browser_navigate', arguments: { url: 'https://example.com' } });
    assert.equal(nav.result.isError, undefined);

    const render = await send('tools/call', { name: 'web.render', arguments: { url: 'https://example.com' } });
    const renderData = JSON.parse(render.result.content[0].text);
    assert.equal(renderData.ok, true);
    assert.equal(renderData.title, 'Stub Title');
    assert.ok(renderData.text.includes('V8'));

    const unknown = await send('tools/call', { name: 'web.nope', arguments: {} });
    assert.equal(unknown.result.isError, true);
  } finally {
    stop();
    await rm(dir, { recursive: true, force: true });
  }
});
