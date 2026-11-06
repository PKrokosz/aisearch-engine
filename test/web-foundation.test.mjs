/**
 * test/web-foundation.test.mjs — AiSearch faza 0-2: types, cache, learn.
 * Uruchom: npm test -- test/web-foundation.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { normalizeUrlKey, domainOf, pathShapeOf, loadWebConfig, INTENT_TYPES } from '../src/engine/types.mjs';
import { WebCache } from '../src/engine/cache.mjs';
import {
  appendLinkLog,
  readLinkLog,
  computePrior,
  priorIndex,
  priorBoost,
  detectDrift,
  linkLogEntry,
  writePrior,
} from '../src/engine/learn.mjs';

const dir = await mkdtemp(join(tmpdir(), 'aisearch-'));
process.on('exit', () => rm(dir, { recursive: true, force: true }));

// ---------------------------------------------------------------- types

test('normalizeUrlKey: www, trailing slash, kolejnosc parametrow', () => {
  const a = normalizeUrlKey('https://www.Example.com/a/b/?z=1&a=2');
  const b = normalizeUrlKey('https://example.com/a/b?a=2&z=1');
  assert.equal(a, b);
});

test('domainOf i pathShapeOf: uczenie na wzorcu, nie dokladnym URL', () => {
  assert.equal(domainOf('https://www.MDN.org/x'), 'mdn.org');
  assert.equal(pathShapeOf('https://ex.com/docs/v20/learn/12345'), 'docs/:ver/learn/:num');
  assert.equal(pathShapeOf('https://ex.com/a/b.php'), 'a/:seg');
});

test('loadWebConfig: domyslne wartosci, brak .env nie jest bledem', () => {
  const cfg = loadWebConfig({});
  assert.equal(cfg.concurrency, 6);
  assert.ok(INTENT_TYPES.includes('official-docs'));
  assert.ok(cfg.proposers.includes('inline'));
});

// ---------------------------------------------------------------- cache

test('cache: sukces i negatyw maja osobne TTL', async () => {
  const c = new WebCache(join(dir, 'c1'));
  await c.load();
  c.resolve.set('https://a.test/', { ok: true, httpStatus: 200 });
  c.resolve.set('https://b.test/', { ok: false, httpStatus: 404 }, { ttl: -1 });
  assert.ok(c.resolve.get('https://a.test/'));
  assert.equal(c.resolve.get('https://b.test/'), null, 'wygasły negatyw nie wraca');
});

test('cache: negative TTL krotszy niz sukces', async () => {
  const c = new WebCache(join(dir, 'c2'));
  await c.load();
  c.resolve.set('good', { ok: true, httpStatus: 200 }, { ttl: 60000 });
  c.resolve.set('bad', { ok: false, httpStatus: 404 }, { ttl: -1 });
  assert.ok(c.resolve.get('good').exp > Date.now());
});

test('cache: stale-while-error zwraca stary wpis ze znacznikiem', async () => {
  const c = new WebCache(join(dir, 'c3'));
  await c.load();
  c.resolve.set('dead', { ok: true, httpStatus: 200 }, { ttl: -1 });
  const stale = c.resolve.getStale('dead');
  assert.equal(stale.stale, true);
  assert.equal(stale.httpStatus, 200);
});

test('cache: single-flight scala wspolbiezne zamdanie tego samego klucza', async () => {
  const c = new WebCache(join(dir, 'c4'));
  await c.load();
  let calls = 0;
  const factory = () => new Promise((r) => setTimeout(() => { calls += 1; r('x'); }, 30));
  const [a, b] = await Promise.all([c.resolve.memo('k', factory), c.resolve.memo('k', factory)]);
  assert.equal(calls, 1, 'jeden request mimo dwoch wywolan');
  assert.equal(a, 'x');
  assert.equal(b, 'x');
  assert.equal(c.resolve.snapshot().singleFlight, 1);
});

test('cache: LRU wyrzuca najstarsze wpisy', async () => {
  const c = new WebCache(join(dir, 'c5'));
  await c.load();
  c.resolve.maxEntries = 3;
  c.resolve.set('a', { ok: true, httpStatus: 200 });
  c.resolve.set('b', { ok: true, httpStatus: 200 });
  c.resolve.set('c', { ok: true, httpStatus: 200 });
  c.resolve.set('d', { ok: true, httpStatus: 200 });
  assert.equal(c.resolve.map.size, 3);
  assert.equal(c.resolve.get('a'), null, 'najstarszy wypadl');
  assert.ok(c.resolve.get('d'));
});

test('cache: przetrwa restart (zapis + odczyt z dysku)', async () => {
  const file = join(dir, 'c6', 'resolve.json');
  const c1 = new WebCache(join(dir, 'c6'));
  await c1.load();
  c1.resolve.set('https://x.test/a', { ok: true, httpStatus: 200, canonical: 'https://x.test/a' });
  await c1.flushAll();
  const c2 = new WebCache(join(dir, 'c6'));
  await c2.load();
  assert.ok(c2.resolve.get('https://x.test/a'), 'wpis wrocil z dysku');
});

// ---------------------------------------------------------------- learn

test('learn: linklog zapis + odczyt + kształt wpisu', async () => {
  const log = join(dir, 'linklog.jsonl');
  const e = linkLogEntry({
    requested: 'https://ex.com/a',
    canonical: 'https://ex.com/b',
    intent: 'official-docs',
    proposedBy: 'inline',
    httpStatus: 200,
    redirects: 1,
    latencyMs: 220,
    score: 0.8,
  });
  assert.equal(e.resolved, true);
  await appendLinkLog(log, e);
  await appendLinkLog(log, linkLogEntry({ requested: 'https://bad.test/', httpStatus: 404, intent: 'repo', proposedBy: 'llm', latencyMs: 60 }));
  const rows = await readLinkLog(log);
  assert.equal(rows.length, 2);
  assert.ok(rows[0].at);
});

test('learn: prior liczy successRate na poziomie (domena, intencja)', async () => {
  const log = join(dir, 'linklog2.jsonl');
  for (let i = 0; i < 8; i += 1) {
    await appendLinkLog(log, linkLogEntry({
      requested: 'https://ex.com/docs', canonical: 'https://ex.com/docs', intent: 'official-docs',
      proposedBy: i % 2 ? 'inline' : 'feeds', httpStatus: 200, redirects: i < 2 ? 1 : 0, latencyMs: 200, utility: i < 5 ? 'used' : null,
    }));
  }
  for (let i = 0; i < 2; i += 1) {
    await appendLinkLog(log, linkLogEntry({ requested: 'https://dead.test/x', intent: 'official-docs', proposedBy: 'llm', httpStatus: 0, latencyMs: 50 }));
  }
  const prior = computePrior(await readLinkLog(log));
  const idx = priorIndex(prior);
  const good = idx.get('ex.com|official-docs');
  const bad = idx.get('dead.test|official-docs');
  assert.equal(good.successRate, 1);
  assert.equal(good.redirectRatio, 0.25, '2 z 8 przekierowan');
  assert.equal(good.utilityRate, 5 / 8);
  assert.equal(bad.successRate, 0);
  assert.ok(priorBoost(idx, 'https://ex.com/docs', 'official-docs') > priorBoost(idx, 'https://dead.test/x', 'official-docs'));
});

test('learn: drift wykrywa skok przekierowan', async () => {
  const log = join(dir, 'linklog3.jsonl');
  for (let i = 0; i < 10; i += 1) {
    await appendLinkLog(log, linkLogEntry({ requested: 'https://drifting.test/docs', intent: 'changelog', proposedBy: 'inline', httpStatus: 200, redirects: 1, latencyMs: 100 }));
  }
  const prior = computePrior(await readLinkLog(log));
  const drift = detectDrift(prior, { threshold: 0.25, minSamples: 5 });
  assert.equal(drift.length, 1);
  assert.equal(drift[0].domain, 'drifting.test');
});

test('learn: prior jest zapisywalny do pliku', async () => {
  const file = join(dir, 'prior.json');
  assert.equal(await writePrior(file, [{ domain: 'ex.com', intent: 'repo', successRate: 1 }]), true);
});
