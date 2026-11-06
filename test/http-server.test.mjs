/**
 * test/http-server.test.mjs — smoke warstwy HTTP (serwer + mostek CLI).
 * Offline: tylko trasy bez sieci (config/stats/eval replay). Sieciowe
 * przebiegi (search/verify_links) są pokryte testami silnika z mock-fetcherem.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dir, '..', 'src', 'http', 'server.mjs');
const BRIDGE = join(__dir, '..', 'src', 'http', 'bridge.mjs');
const PORT = 8791;

async function waitUp(url, timeoutMs = 10000) {
  const t0 = Date.now();
  for (;;) {
    try {
      await fetch(url);
      return;
    } catch {
      if (Date.now() - t0 > timeoutMs) throw new Error('serwer nie wstał');
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

test('HTTP: config/stats/eval(online zero) + 404 + 401 z kluczem', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aisearch-http-'));
  const child = spawn(process.execPath, [SERVER], {
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, WEB_HTTP_PORT: String(PORT), WEB_HTTP_HOST: '127.0.0.1', WEB_CACHE_DIR: dir, WEB_API_KEY: 'sekret' },
  });
  try {
    await waitUp(`http://127.0.0.1:${PORT}/web/config`);

    const noAuth = await fetch(`http://127.0.0.1:${PORT}/web/stats`);
    assert.equal(noAuth.status, 401, 'bez klucza = 401');

    const cfg = await fetch(`http://127.0.0.1:${PORT}/web/config`, { headers: { authorization: 'Bearer sekret' } });
    assert.equal(cfg.status, 200);
    const cfgData = await cfg.json();
    assert.equal(cfgData.ok, true);
    assert.ok('config' in cfgData);

    const stats = await fetch(`http://127.0.0.1:${PORT}/web/stats`, { headers: { authorization: 'Bearer sekret' } });
    assert.equal(stats.status, 200);

    const notFound = await fetch(`http://127.0.0.1:${PORT}/web/nope`, { headers: { authorization: 'Bearer sekret' } });
    assert.equal(notFound.status, 404);

    const bad = await fetch(`http://127.0.0.1:${PORT}/web/feedback`, {
      method: 'POST',
      headers: { authorization: 'Bearer sekret', 'content-type': 'application/json' },
      body: 'to nie json',
    });
    assert.equal(bad.status, 400);
  } finally {
    child.kill();
    await new Promise((r) => setTimeout(r, 300));
    await rm(dir, { recursive: true, force: true });
  }
});

test('mostek CLI: stats i eval replay przez stdin/stdout', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aisearch-bridge-'));
  try {
    const runBridge = (mode, input) =>
      new Promise((resolve, reject) => {
        const p = spawn(process.execPath, [BRIDGE, mode], {
          stdio: ['pipe', 'pipe', 'inherit'],
          env: { ...process.env, WEB_CACHE_DIR: dir, WEB_RENDER: 'off' },
        });
        let out = '';
        p.stdout.on('data', (d) => (out += d.toString()));
        p.on('error', reject);
        p.on('close', () => {
          try {
            resolve(JSON.parse(out));
          } catch (e) {
            reject(new Error(`mostek: nie-JSON (${out.slice(0, 200)})`));
          }
        });
        p.stdin.write(JSON.stringify(input || {}));
        p.stdin.end();
      });

    const stats = await runBridge('stats');
    assert.equal(stats.ok, true);
    assert.ok(stats.cache);

    const badMode = await new Promise((resolve) => {
      const p = spawn(process.execPath, [BRIDGE, 'nie-taki-tryb'], { stdio: ['pipe', 'pipe', 'inherit'] });
      let out = '';
      p.stdout.on('data', (d) => (out += d.toString()));
      p.on('close', () => resolve(JSON.parse(out)));
      p.stdin.end();
    });
    assert.equal(badMode.ok, false);
    assert.equal(badMode.error.includes('nieznany tryb'), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
