/**
 * test/web-pipeline.test.mjs — AiSearch faza 3: plan, falsify, propose, resolve.
 * resolve testowany z fałszywym fetcherem — zero sieci, pełna deterministyka.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { planQuery, describePlan, INTENT_KEYWORDS } from '../src/engine/plan.mjs';
import { scoreCandidate, coverageOf, htmlToText, extractMeta, tokenize } from '../src/engine/falsify.mjs';
import { resolveCandidates, variantFamilies, HostGate } from '../src/engine/resolve.mjs';
import { proposeInline, parseLlmCandidates, dedupeCandidates, domainsFromPrior } from '../src/engine/propose.mjs';
import { WebCache } from '../src/engine/cache.mjs';
import { normalizeUrlKey } from '../src/engine/types.mjs';

const dir = await mkdtemp(join(tmpdir(), 'aisearch-p-'));
process.on('exit', () => rm(dir, { recursive: true, force: true }));

const cfg = {
  maxRequests: 24,
  concurrency: 6,
  timeoutMs: 5000,
  coverageThreshold: 0.35,
  waybackEnabled: true,
};

const HTML_OK = `<html><head><title>PHP 8.4 Release Announcement</title>
<meta name="description" content="PHP 8.4 changelog release notes upgrade notes">
<meta property="article:published_time" content="2024-09-19T00:00:00Z">
<link rel="canonical" href="https://www.php.net/releases/8.4/en.php"></head>
<body><h1>PHP 8.4</h1><p>Property hooks, asymmetric visibility, changelog of release 8.4</p></body></html>`;

/** Fałszywy fetcher: mapuje URL → odpowiedź, zapisuje kolejność wywołań. */
function makeFetcher(routes = {}) {
  const calls = [];
  const fetcher = async (url, opts = {}) => {
    calls.push({ url, redirect: opts.redirect });
    const r = routes[url];
    if (!r) return { status: 404, headers: { get: () => null }, text: async () => '<html><title>Nie ma</title></html>', json: async () => ({}) };
    return {
      status: r.status,
      headers: { get: (h) => (h.toLowerCase() === 'location' ? r.location || null : null) },
      text: async () => r.body ?? '<html><title>x</title></html>',
      json: async () => JSON.parse(r.body ?? 'null'),
    };
  };
  return { fetcher, calls };
}

/** Strona bez <link rel=canonical> — kanoniczny URL musi wyjść z samego redirectu. */
const HTML_NO_CANONICAL = '<html><head><title>If-None-Match header - HTTP | MDN</title></head><body><h1>If-None-Match</h1></body></html>';

// ---------------------------------------------------------------- plan

test('plan: "changelog PHP 8.4" -> intencja changelog, swiezosc recent', () => {
  const plan = planQuery({ query: 'changelog PHP 8.4' }, cfg);
  assert.ok(plan.intents.includes('changelog'));
  assert.equal(plan.staleness, 'recent');
  assert.ok(plan.budget.maxCandidatesPerIntent >= 3);
});

test('plan: zapytanie o CVE -> advisory + fresh (swieżość najwyższa)', () => {
  const plan = planQuery({ query: 'CVE-2024-1234 exploit vulnerability KEV' }, cfg);
  assert.ok(plan.intents.includes('advisory'));
  assert.equal(plan.staleness, 'fresh');
});

test('plan: brak slow kluczowych -> domyslne official-docs + reference', () => {
  const plan = planQuery({ query: 'zzz qqq' }, cfg);
  assert.deepEqual(plan.intents, ['official-docs', 'reference']);
});

test('plan: wagi sumuja sie do 1', () => {
  const plan = planQuery({ query: 'github repo documentation changelog' }, cfg);
  const sum = Object.values(plan.weights).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 0.01, `suma wag = ${sum}`);
  assert.ok(describePlan(plan).includes('intencje'));
});

test('plan: jawna intencja z args ma pierwszenstwo', () => {
  const plan = planQuery({ query: 'cokolwiek', intents: ['advisory'] }, cfg);
  assert.equal(plan.intents[0], 'advisory');
});

// ---------------------------------------------------------------- falsify

test('falsify: htmlToText i extractMeta bez zadnej zaleznosci npm', () => {
  const meta = extractMeta(HTML_OK, 'https://www.php.net/releases/8.4/en.php');
  assert.match(meta.title, /PHP 8\.4/);
  assert.equal(meta.canonical, 'https://www.php.net/releases/8.4/en.php');
  assert.equal(typeof meta.publishedMs, 'number');
  const text = htmlToText(HTML_OK);
  assert.ok(!text.includes('<h1>'));
  assert.ok(text.includes('Property hooks'));
});

test('falsify: tokenizacja odrzuca stopwords PL/EN', () => {
  const t = tokenize('jak zrobic dokumentacje dla PHP');
  assert.ok(t.includes('dokumentacje'));
  assert.ok(!t.includes('jak'));
  assert.ok(!t.includes('dla'));
});

test('falsify: trafny kandydat ma wysoki score, off-topic niski', () => {
  const common = { query: 'changelog PHP 8.4', staleness: 'recent' };
  const good = scoreCandidate({ ...common, title: 'PHP 8.4 Release Announcement', text: 'PHP 8.4 changelog release notes', publishedMs: Date.parse('2024-09-19'), latencyMs: 210 });
  const bad = scoreCandidate({ ...common, title: 'Kurs gotowania', text: 'przepis na rosół', publishedMs: Date.parse('2019-01-01'), latencyMs: 1800 });
  assert.ok(good.score > 0.55, `good=${good.score}`);
  assert.ok(good.ok);
  assert.ok(bad.score < 0.25, `bad=${bad.score}`);
  assert.ok(!bad.ok);
});

test('falsify: brak daty = 0.5 neutralnie (nie karamy dokumentacji bez daty)', () => {
  const s = scoreCandidate({ query: 'php docs', title: 'PHP docs', text: 'php', publishedMs: null, latencyMs: 100 });
  assert.equal(s.signals.freshness, 0.5);
});

test('falsify: coverage — pusta lista jawnie uznana za brak', () => {
  const c = coverageOf([], { coverage: 0.35 });
  assert.equal(c.score, 0);
  assert.equal(c.needFallback, true);
});

// ---------------------------------------------------------------- resolve

test('resolve: redirect naprawia zly URL i liczy hop-y (eksperyment MDN)', async () => {
  const { fetcher, calls } = makeFetcher({
    'https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/If-None-Match': {
      status: 301,
      location: 'https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/If-None-Match',
    },
    'https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/If-None-Match': { status: 200, body: HTML_NO_CANONICAL },
  });
  const cache = new WebCache(join(dir, 'r1'));
  await cache.load();
  const out = await resolveCandidates(
    [{ url: 'https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/If-None-Match', intent: 'official-docs', proposedBy: 'inline', confidence: 0.6 }],
    { cfg, cache, fetcher }
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].httpStatus, 200);
  assert.equal(out[0].canonical, 'https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/If-None-Match');
  assert.equal(out[0].redirects, 1, 'jeden hop przekierowania');
  assert.equal(out[0].title, 'If-None-Match header - HTTP | MDN', 'metadane z TEJ SAMEJ odpowiedzi');
});

test('resolve: wymyslony URL odrzucony i zapisany w negatywnym cache', async () => {
  const { fetcher } = makeFetcher({});
  const cache = new WebCache(join(dir, 'r2'));
  await cache.load();
  const out = await resolveCandidates([{ url: 'https://srv120794.seohost.com.pl/docs/nginx-modern-setting', intent: 'repo', proposedBy: 'llm', confidence: 0.9 }], { cfg, cache, fetcher });
  assert.equal(out[0].ok, false);
  assert.equal(out[0].httpStatus, 404);
  assert.ok(out[0].error);
});

test('resolve: kandydaci rozstrzygnieci rownolegle — watki wzgledem limitu', async () => {
  const urls = ['a.test', 'b.test', 'c.test', 'd.test', 'e.test', 'f.test'].map((h) => ({ url: `https://${h}/x`, intent: 'repo', proposedBy: 'inline' }));
  const routes = {};
  for (const h of ['a.test', 'b.test', 'c.test', 'd.test', 'e.test', 'f.test']) routes[`https://${h}/x`] = { status: 200, body: HTML_OK };
  const { fetcher, calls } = makeFetcher(routes);
  const cache = new WebCache(join(dir, 'r3'));
  await cache.load();

  let inFlight = 0;
  let maxInFlight = 0;
  const slow = async (url, opts) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 40));
    inFlight -= 1;
    return fetcher(url, opts);
  };
  const c2 = { ...cfg, concurrency: 3 };
  const out = await resolveCandidates(urls, { cfg: c2, cache, fetcher: slow });
  assert.equal(out.length, 6);
  assert.equal(calls.length, 6);
  assert.ok(maxInFlight <= 3, `maksymalnie ${maxInFlight} na raz (limit 3)`);
  assert.ok(maxInFlight > 1, 'a jednak rownolegle, nie sekwencyjnie');
});

test('resolve: single-flight — ten sam URL dwa razy = jeden request', async () => {
  const routes = { 'https://x.test/a': { status: 200, body: HTML_OK } };
  const { fetcher, calls } = makeFetcher(routes);
  const cache = new WebCache(join(dir, 'r4'));
  await cache.load();
  await Promise.all([
    resolveCandidates([{ url: 'https://x.test/a', intent: 'repo', proposedBy: 'inline' }], { cfg, cache, fetcher }),
    resolveCandidates([{ url: 'https://www.x.test/a', intent: 'repo', proposedBy: 'inline' }], { cfg, cache, fetcher }),
  ]);
  assert.equal(calls.length, 1, 'www zostalo znormalizowane do tego samego klucza');
  assert.equal(cache.resolve.snapshot().singleFlight, 1);
});

test('resolve: cache resolve eliminuje drugi request (0 requestow)', async () => {
  const routes = { 'https://y.test/a': { status: 200, body: HTML_OK } };
  const { fetcher, calls } = makeFetcher(routes);
  const cache = new WebCache(join(dir, 'r5'));
  await cache.load();
  const cand = [{ url: 'https://y.test/a', intent: 'repo', proposedBy: 'inline' }];
  await resolveCandidates(cand, { cfg, cache, fetcher });
  await resolveCandidates(cand, { cfg, cache, fetcher });
  assert.equal(calls.length, 1);
  assert.equal(cache.resolve.snapshot().hits, 1);
});

test('resolve: budzet requestow jest szanowany', async () => {
  const routes = {};
  for (const h of ['a.test', 'b.test', 'c.test']) routes[`https://${h}/x`] = { status: 200, body: HTML_OK };
  const { fetcher, calls } = makeFetcher(routes);
  const cache = new WebCache(join(dir, 'r6'));
  await cache.load();
  await resolveCandidates(
    ['a.test', 'b.test', 'c.test'].map((h) => ({ url: `https://${h}/x`, intent: 'repo', proposedBy: 'llm' })),
    { cfg: { ...cfg, maxRequests: 2 }, cache, fetcher }
  );
  assert.equal(calls.length, 2, 'budzet uciety do 2');
});

test('resolve: martwy link -> kopia Wayback (archiwum ratuje)', async () => {
  const { fetcher } = makeFetcher({
    'https://archive.org/wayback/available?url=https%3A%2F%2Fdead.test%2Fpage': {
      status: 200,
      body: JSON.stringify({ archived: { closest: { url: 'https://web.archive.org/web/2023/https://dead.test/page', timestamp: '20230101' } } }),
    },
  });
  const cache = new WebCache(join(dir, 'r7'));
  await cache.load();
  const out = await resolveCandidates([{ url: 'https://dead.test/page', intent: 'reference', proposedBy: 'llm' }], { cfg, cache, fetcher });
  assert.equal(out[0].archived, true);
  assert.match(out[0].canonical, /web\.archive\.org/);
});

test('resolve: pad sieci -> stale-while-error zamiast pustej odpowiedzi', async () => {
  const cache = new WebCache(join(dir, 'r8'));
  await cache.load();
  const cand = [{ url: 'https://ok.test/a', intent: 'repo', proposedBy: 'inline' }];
  await resolveCandidates(cand, { cfg, cache, fetcher: makeFetcher({ 'https://ok.test/a': { status: 200, body: HTML_OK } }).fetcher });
  // Wygasamy wpis w cache: świeży hit też byłby poprawny, ale testujemy gałąź stale.
  const key = normalizeUrlKey('https://ok.test/a');
  cache.resolve.map.get(key).exp = Date.now() - 1;
  const failing = async () => { throw new Error('ECONNRESET'); };
  const out = await resolveCandidates(cand, { cfg: { ...cfg, waybackEnabled: false }, cache, fetcher: failing });
  assert.equal(out[0].ok, true);
  assert.equal(out[0].stale, true, 'stara wartosc ze znacznikiem stale');
});

test('resolve: wariant github blob -> raw.githubusercontent', () => {
  const v = variantFamilies('https://github.com/nodejs/node/blob/main/doc/changelogs/CHANGELOG_V22.md');
  assert.ok(v.includes('https://raw.githubusercontent.com/nodejs/node/main/doc/changelogs/CHANGELOG_V22.md'));
  assert.ok(v.length <= 3);
});

test('resolve: HostGate trzyma odstep miedzy requestami do tego samego hosta', async () => {
  const gate = new HostGate(60);
  const t0 = Date.now();
  await gate.wait('h.test');
  await gate.wait('h.test');
  assert.ok(Date.now() - t0 >= 50, 'drugi request odczekał');
});

// ---------------------------------------------------------------- propose

test('propose: inline — zgadywanie agenta bez sieci i tokenow', () => {
  const plan = planQuery({ query: 'repo dla PHP docs' }, cfg);
  const cands = proposeInline(['https://github.com/php/php-src', 'https://www.php.net/docs/'], plan);
  assert.equal(cands.length, 2);
  assert.equal(cands[0].proposedBy, 'inline');
  assert.equal(cands[0].intent, 'repo', 'github rozpoznany jako repo');
});

test('propose: dedupe po kluczu znormalizowanym (www nie dubluje)', () => {
  const out = dedupeCandidates([
    { url: 'https://ex.com/a/', confidence: 0.5 },
    { url: 'https://www.ex.com/a', confidence: 0.5 },
    { url: 'https://ex.com/a', confidence: 0.9 },
  ]);
  assert.equal(out.length, 1);
});

test('propose: parser LLM przetrwa otoczenie i smieci', () => {
  const plan = planQuery({ query: 'x' }, cfg);
  const parsed = parseLlmCandidates('Oto moja odpowiedź:\n```json\n[{"url":"https://ex.com/a","intent":"repo","confidence":0.8,"reason":"bo tak"}]\n```\nmam nadzieję że pomogłem', plan);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].intent, 'repo');
  assert.equal(parseLlmCandidates('nie wiem, brak pomysłu', plan).length, 0, 'pusta tablica = poprawna odpowiedź');
  assert.equal(parseLlmCandidates('[{"url":"/relatywna"}]', plan).length, 0, 'względne odrzucone');
  const clamped = parseLlmCandidates('[{"url":"https://ex.com/b","intent":"nie-istnieje","confidence":7}]', plan);
  assert.equal(clamped[0].confidence, 1);
});

test('propose: domeny z priora — wskazowki, nie kandydaci', () => {
  const prior = [
    { domain: 'ex.com', intent: 'repo', n: 10, successRate: 1, utilityRate: 0.8, redirectRatio: 0 },
    { domain: 'bad.test', intent: 'repo', n: 10, successRate: 0.1, utilityRate: 0, redirectRatio: 0.9 },
    { domain: 'thin.test', intent: 'repo', n: 1, successRate: 1, utilityRate: 1, redirectRatio: 0 },
  ];
  const domains = domainsFromPrior(prior, ['repo'], 5);
  assert.ok(domains.includes('ex.com'));
  assert.ok(!domains.includes('bad.test'), 'dryfujaca/słaba domena nie jest wskazywana');
  assert.ok(!domains.includes('thin.test'), 'za mało prob — brak wnioskowania');
});
