/**
 * test/browser-render.test.mjs — eskalacja do przeglądarki (Obscura).
 *
 * Wszystko offline: renderer jest fałszywą otoczką (renderPage), fetcher
 * silnika — też. Testuje POLITYKĘ (kto, kiedy, ile), nie silnik V8.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { renderPass, BrowserRenderer } from '../src/browser/render.mjs';
import { AiSearch } from '../src/engine/pipeline.mjs';
import { loadWebConfig } from '../src/engine/types.mjs';

function fakeResolved(texts) {
  return texts.map((t, i) => ({
    url: `https://example.com/page${i}`,
    canonical: `https://example.com/page${i}`,
    ok: true,
    httpStatus: 200,
    title: '',
    text: t,
    redirects: 0,
  }));
}

test('auto: renderuje tylko JS-shelle (200 z treścią < progu)', async () => {
  const calls = [];
  const renderer = {
    renderPage: async (url) => {
      calls.push(url);
      return { ok: true, url, title: 'Rendered', text: 'x'.repeat(500) };
    },
  };
  const resolved = fakeResolved(['pełna treść na tyle długa, że fetch wystarczy'.repeat(10), '']);

  const stats = await renderPass(resolved, {
    renderer,
    cfg: { renderMinText: 200, renderMax: 3, renderTimeoutMs: 1000 },
    mode: 'auto',
  });

  assert.equal(stats.rendered, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0], 'https://example.com/page1');
  assert.equal(resolved[1].rendered, true);
  assert.equal(resolved[1].title, 'Rendered');
  assert.equal(resolved[0].rendered, undefined);
});

test('budget: drugi shell czeka, gdy renderMax = 1', async () => {
  const events = [];
  const renderer = { renderPage: async (url) => ({ ok: true, url, title: null, text: 'y'.repeat(400) }) };
  const resolved = fakeResolved(['', '']);

  const stats = await renderPass(resolved, {
    renderer,
    cfg: { renderMinText: 200, renderMax: 1 },
    mode: 'auto',
    onEvent: (ev) => events.push(ev),
  });

  assert.equal(stats.rendered, 1);
  assert.equal(stats.budget, 1);
  assert.ok(events.some((e) => e.type === 'render-budget'));
});

test('brak renderera / tryb off = zero pracy', async () => {
  const resolved = fakeResolved(['']);
  const s1 = await renderPass(resolved, { renderer: null, cfg: { renderMax: 3 }, mode: 'auto' });
  const s2 = await renderPass(resolved, { renderer: { renderPage: async () => { throw new Error('nie'); } }, cfg: { renderMax: 3 }, mode: 'off' });
  assert.deepEqual(s1, { rendered: 0, skipped: 0, errors: 0, budget: 0 });
  assert.deepEqual(s2, { rendered: 0, skipped: 0, errors: 0, budget: 0 });
});

test('pad renderera nie wywala przebiegu — idzie dalej z fetch', async () => {
  const renderer = { renderPage: async () => { throw new Error('V8 exploded'); } };
  const resolved = fakeResolved(['']);
  const stats = await renderPass(resolved, { renderer, cfg: { renderMax: 1 }, mode: 'auto' });
  assert.equal(stats.errors, 1);
  assert.equal(resolved[0].text, '');
});

test('BrowserRenderer liczy wywołania', async () => {
  let n = 0;
  const client = { renderPage: async (url) => { n += 1; return { ok: true, url, title: 't', text: 'z'.repeat(300) }; }, close: async () => {} };
  const r = new BrowserRenderer({ client });
  await r.renderPage('https://example.com');
  await r.close();
  assert.equal(r.renders, 1);
  assert.equal(n, 1);
});

test('integracja: pipeline offline — fetch bez treści → render → wynik', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aisearch-render-'));
  try {
    const cfg = { ...loadWebConfig({}), serpEnabled: false, renderMinText: 200, renderMax: 2, proposers: ['inline'] };
    const fetcher = async (url) => ({
      status: 200,
      url,
      headers: { get: () => null },
      text: async () => '<html><head><title>Shell</title></head><body><div id="root"></div></body></html>',
    });
    const renderer = {
      renderPage: async (url) => ({
        ok: true,
        url,
        title: 'PHP 8.4 Release Announcement',
        text: 'PHP 8.4 release announcement changelog. Property hooks, DOM HTML5 support. '.repeat(8),
      }),
    };
    const search = new AiSearch({ cfg, cacheDir: dir, logFile: join(dir, 'linklog.jsonl'), priorFile: join(dir, 'prior.json'), fetcher, renderer });
    const res = await search.search({
      query: 'PHP 8.4 release announcement changelog',
      urls: ['https://www.php.net/releases/8.4/en.php'],
      top: 5,
    });

    assert.equal(res.ok, true);
    assert.equal(res.stats.renders, 1, 'pipeline powinno użyć dokładnie jednego renderu');
    assert.ok(res.results.some((r) => r.rendered === true), 'przynajmniej jeden wynik z przeglądarki');
    await search.flush();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
