/**
 * test/web-feedindex.test.mjs — AiSearch faza 4: feedindex (RSS/Atom, 304, warianty wersji).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FeedIndex, parseFeed, withVersionVariants } from '../src/engine/feedindex.mjs';
import { WebCache } from '../src/engine/cache.mjs';

const dir = await mkdtemp(join(tmpdir(), 'aisearch-f-'));
process.on('exit', () => rm(dir, { recursive: true, force: true }));

const cfg = { timeoutMs: 5000, feedRefreshMs: 60000, feedMaxItems: 200 };

const ATOM = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry><title>PHP 8.4.27</title><link rel="alternate" href="https://github.com/php/php-src/releases/tag/php-8.4.27"/><updated>2026-10-20T10:00:00Z</updated></entry>
  <entry><title>PHP 8.5.12</title><link rel="alternate" href="https://github.com/php/php-src/releases/tag/php-8.5.12"/><updated>2026-10-21T10:00:00Z</updated></entry>
</feed>`;

test('feedindex: parser RSS + Atom bez zaleznosci npm', () => {
  const atom = parseFeed(ATOM, 'https://github.com/php/php-src/releases.atom', 'changelog');
  assert.equal(atom.length, 2);
  assert.equal(atom[0].title, 'PHP 8.4.27');
  assert.match(atom[0].link, /tag\/php-8\.4\.27$/);
  assert.equal(atom[0].intent, 'changelog');

  const rss = parseFeed(
    `<?xml version="1.0"?><rss><channel><item><title>Node 22</title><link>https://nodejs.org/en/blog/release/v22.11.0</link><pubDate>Mon, 20 Oct 2026 10:00:00 GMT</pubDate></item></channel></rss>`,
    'https://nodejs.org/feed',
    'changelog'
  );
  assert.equal(rss.length, 1);
  assert.equal(rss[0].link, 'https://nodejs.org/en/blog/release/v22.11.0');
});

test('feedindex: warianty wersji — 8.4 trafia w tytul 8.4.27', () => {
  assert.ok(withVersionVariants(['8.4.27']).has('8.4'));
  assert.ok(withVersionVariants(['php']).has('php'));
  assert.ok(withVersionVariants(['v20.1.2']).has('20.1'));
});

test('feedindex: match zwraca swiezy item dla zapytania o wersje', async () => {
  const cache = new WebCache(join(dir, 'f1'));
  await cache.load();
  const fetcher = async () => ({
    status: 200,
    headers: { get: () => null },
    text: async () => ATOM,
  });
  const fi = new FeedIndex({ cache, cfg, fetcher });
  await fi.addFeed('https://github.com/php/php-src/releases.atom', { intent: 'changelog' });
  await fi.reindex({ force: true });
  const hits = fi.match({ query: 'changelog PHP 8.4', intent: 'changelog', limit: 5 });
  assert.ok(hits.length >= 1, `trafienia: ${JSON.stringify(hits.map((h) => h.title))}`);
  assert.match(hits[0].title, /8\.4/);
});

test('REGRESJA: 304 nie niszczy indeksu (wygasly wpis + 304 = utrata danych)', async () => {
  const cache = new WebCache(join(dir, 'f2'));
  await cache.load();
  const php = 'https://github.com/php/php-src/releases.atom';
  const fetcher = async (url, opts = {}) => {
    if (!String(url).includes('php-src')) return { status: 404, headers: { get: () => null }, text: async () => '' };
    const conditional = Boolean(opts.headers?.['if-none-match']);
    if (conditional) return { status: 304, headers: { get: () => null }, text: async () => '' };
    return { status: 200, headers: { get: (h) => (h.toLowerCase() === 'etag' ? 'W/"abc"' : null) }, text: async () => ATOM };
  };
  const fi = new FeedIndex({ cache, cfg, fetcher });
  await fi.addFeed(php, { intent: 'changelog' });

  // 1. pelne pobranie
  await fi.reindex({ force: true });
  assert.equal(fi.allItems().length, 2);

  // 2. wygasnij wpis (symulacja uplyniecia TTL), potem 304
  for (const [key, entry] of cache.feeds.map.entries()) {
    if (key !== '__registry__') entry.exp = Date.now() - 1;
  }
  const r = await fi.reindex({ force: true });
  assert.equal(r.notModified, 1, 'serwer odpowiedzial 304');

  assert.equal(fi.allItems().length, 2, 'itemy PRZETRWAŁY 304 — to ta regresja');
  const entry = [...cache.feeds.map.values()].find((e) => e.feedUrl?.includes('php-src'));
  assert.equal(entry.items.length, 2);
  assert.equal(entry.etag, 'W/"abc"', 'etag tez przetrwal (conditional GET dalej dziala)');
  // 3. kolejny przebieg nadal działa z 304
  assert.equal((await fi.reindex({ force: true })).notModified, 1);
  assert.equal(fi.allItems().length, 2);
});

test('feedindex: blad HTTP nie kasuje zebranych itemow', async () => {
  const cache = new WebCache(join(dir, 'f3'));
  await cache.load();
  const php = 'https://github.com/php/php-src/releases.atom';
  let phase = 'ok';
  const fetcher = async (url) => {
    if (!String(url).includes('php-src')) return { status: 404, headers: { get: () => null }, text: async () => '' };
    if (phase === 'ok') return { status: 200, headers: { get: () => null }, text: async () => ATOM };
    return { status: 500, headers: { get: () => null }, text: async () => 'boom' };
  };
  const fi = new FeedIndex({ cache, cfg, fetcher });
  await fi.addFeed(php, { intent: 'changelog' });
  await fi.reindex({ force: true });
  assert.equal(fi.allItems().length, 2);

  phase = 'fail';
  for (const [key, entry] of cache.feeds.map.entries()) if (key !== '__registry__') entry.exp = Date.now() - 1;
  const r = await fi.reindex({ force: true });
  assert.ok(r.failed >= 1);
  assert.equal(fi.allItems().length, 2, 'indeks zostatł — serwujemy co mamy');
});

test('feedindex: rejestr — dodanie, duplikat, usuniecie', async () => {
  const cache = new WebCache(join(dir, 'f4'));
  await cache.load();
  const fi = new FeedIndex({ cache, cfg, fetcher: async () => ({ status: 200, headers: { get: () => null }, text: async () => ATOM }) });
  const base = await fi.listFeeds();
  assert.ok(await fi.addFeed('https://example.test/feed.xml', { intent: 'news', name: 'x' }));
  assert.equal(await fi.addFeed('https://example.test/feed.xml'), false, 'duplikat odrzucony');
  const after = await fi.listFeeds();
  assert.equal(after.length, base.length + 1);
  await fi.removeFeed('https://example.test/feed.xml');
  assert.equal((await fi.listFeeds()).length, base.length);
});

test('feedindex: martwy feed nie wysypuje pipelineu (0 kandydatow, nie blad)', async () => {
  const cache = new WebCache(join(dir, 'f5'));
  await cache.load();
  const fixture = new FeedIndex({
    cache,
    cfg,
    fetcher: async () => {
      throw new Error('ENOTFOUND');
    },
  });
  await fixture.addFeed('https://dead.test/feed', { intent: 'news' });
  const registered = (await fixture.listFeeds()).length;
  const r = await fixture.reindex({ force: true });
  assert.equal(r.failed, registered, `wszystkie ${registered} kanału padły`);
  assert.equal(r.ok, 0);
  assert.deepEqual(fixture.match({ query: 'cokolwiek', intent: 'news' }), []);
});
