/**
 * test/web-dashboard.test.mjs — AiSearch: dashboard (TUI + tryb tekstowy) i narrate().
 * Render sprawdzamy z podstdawionym stdout — bez prawdziwego terminala,
 * ale z pelna logika ramek, paddingow i szerokosci.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Dashboard } from '../src/engine/dashboard.mjs';
import { narrate } from '../src/engine/pipeline.mjs';

/** Przechwytuje to, co dashboard wysyła na ekran. */
function captureStdout(columns = 120, rows = 40) {
  const chunks = [];
  const original = {
    write: process.stdout.write.bind(process.stdout),
    columns: process.stdout.columns,
    rows: process.stdout.rows,
    isTTY: process.stdout.isTTY,
  };
  process.stdout.write = (chunk, ...rest) => {
    chunks.push(String(chunk));
    return true;
  };
  process.stdout.columns = columns;
  process.stdout.rows = rows;
  return {
    chunks,
    text: () => chunks.join(''),
    restore: () => {
      process.stdout.write = original.write;
      process.stdout.columns = original.columns;
      process.stdout.rows = original.rows;
    },
  };
}

const EVENTS = [
  { stage: 'plan', type: 'plan-done', summary: '3 intencje (official-docs 60%, changelog 40%), swieżość: recent', query: 'changelog PHP 8.4' },
  { stage: 'propose', type: 'propose-source', by: 'inline', count: 3, message: 'inline: 3 kandydatów' },
  { stage: 'propose', type: 'propose-done', count: 3, sources: { inline: 3 }, message: 'koniec: 3 kandydatów' },
  { stage: 'resolve', type: 'request', url: 'https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/If-None-Match' },
  { stage: 'resolve', type: 'resolved', url: 'https://www.php.net/releases/8.4/en.php', canonical: 'https://www.php.net/releases/8.4/en.php', repaired: false },
  { stage: 'resolve', type: 'resolved', url: 'https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/If-None-Match', canonical: 'https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/If-None-Match', redirects: 1, repaired: true },
  { stage: 'resolve', type: 'dead', url: 'https://nie-ma.example/docs', status: 404 },
  { stage: 'resolve', type: 'archived', url: 'https://stare.example/x', canonical: 'https://web.archive.org/web/2023/https://stare.example/x' },
  { stage: 'resolve', type: 'resolve-done', message: 'koniec: 2/3 zweryfikowanych, 1 naprawionych, 5 requestów' },
  { stage: 'falsify', type: 'falsify-done', kept: 2, verified: 2, threshold: 0.25, coverage: 0.71 },
  { stage: 'falsify', type: 'fallback', coverage: 0.2, threshold: 0.35 },
  { stage: 'falsify', type: 'fallback-done', count: 5, note: null },
  { stage: 'learn', type: 'learn-done', entries: 3, drift: null },
  {
    stage: 'final',
    type: 'final',
    result: {
      query: 'changelog PHP 8.4',
      intents: ['changelog'],
      results: [
        { rank: 1, url: 'https://www.php.net/releases/8.4/en.php', title: 'PHP: PHP 8.4 Release Announcement', score: 0.71, repaired: false, archived: false, fromCache: false, domain: 'php.net', requestedUrl: 'https://www.php.net/releases/8.4/en.php', signals: {} },
        { rank: 2, url: 'https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/If-None-Match', title: 'If-None-Match header - HTTP | MDN', score: 0.66, repaired: true, archived: false, fromCache: true, domain: 'developer.mozilla.org', requestedUrl: 'https://developer.mozilla.org/x', signals: {} },
      ],
      coverage: 0.71,
      stats: { candidates: 3, verified: 2, requests: 5, cacheHits: 0, ms: 874, sources: { inline: 3 } },
    },
  },
];

test('dashboard: TUI rysuje wszystkie podpisane panele', () => {
  const dash = new Dashboard({ tty: true });
  const cap = captureStdout(120, 40);
  try {
    for (const ev of EVENTS) dash.event(ev);
    dash.render(true);
    const out = cap.text();
    for (const title of ['PLAN', 'PROPOSE', 'RESOLVE', 'FALSIFY', 'LEARN', 'WYNIKI', 'LOG', 'AiSearch']) {
      assert.ok(out.includes(title), `pulpit zawiera panel ${title}`);
    }
    // ramki
    assert.ok(out.includes('\u250c'), 'ramka górna');
    assert.ok(out.includes('\u2502'), 'ramka boczna');
    // wyniki z provenance
    assert.ok(out.includes('PHP: PHP 8.4 Release Announcement'));
    assert.ok(out.includes('naprawiony'), 'flaga naprawy przez redirect');
    assert.ok(out.includes('cache'), 'flaga trafienia cache');
    // tylko jeden ekran naraz: clr + home na poczatku
    assert.ok(out.startsWith('\x1b[2J\x1b[H'), 'czyszczenie ekranu przed rysunkiem');
    // zaden wiersz nie dluzszy niz ekran
    const lines = out.split('\r\n');
    for (const line of lines) {
      assert.ok(line.length <= 121, `linia za dluga (${line.length})`);
    }
  } finally {
    cap.restore();
  }
});

test('dashboard: maly terminal przechodzi w tryb tekstowy', () => {
  const dash = new Dashboard({ tty: true });
  dash.event({ stage: 'plan', type: 'plan-done', summary: 'test planu', query: 'x' });
  const cap = captureStdout(40, 10);
  try {
    dash.render(true);
    assert.equal(dash.tty, false, 'brak miejsca → tekst');
    // tekstowy tryb wypisuje linie, ale BEZ ramek TUI
    assert.ok(cap.text().length > 0, 'przelaczylo na wypisywanie tekstu');
    assert.ok(!cap.text().includes('\u250c'), 'zadnych ramek w trybie tekstowym');
  } finally {
    cap.restore();
  }
});

test('dashboard: tryb tekstowy wypisuje zdarzenia jako linie', () => {
  const dash = new Dashboard({ tty: false });
  const cap = captureStdout();
  try {
    for (const ev of EVENTS.slice(0, 4)) dash.event(ev);
    dash.renderText(true);
    const out = cap.text();
    assert.ok(out.includes('plan:'), out);
    assert.ok(out.includes('propozycja inline: 3 kandydatów'));
  } finally {
    cap.restore();
  }
});

test('narrate: kazdy etap ma zdanie w jezyku naturalnym', () => {
  const cases = [
    [{ type: 'start', query: 'changelog PHP 8.4' }, /szukam:/],
    [{ stage: 'plan', type: 'plan-done', summary: 'x intencje' }, /plan:/],
    [{ stage: 'resolve', type: 'resolved', url: 'https://a.test/x', canonical: 'https://a.test/x', repaired: false }, /trafione:/],
    [{ stage: 'resolve', type: 'resolved', url: 'https://a.test/x', canonical: 'https://a.test/y', redirects: 1, repaired: true }, /naprawione:.*redirect/],
    [{ stage: 'resolve', type: 'dead', url: 'https://a.test/x', status: 404 }, /odrzucone:/],
    [{ stage: 'resolve', type: 'cache-hit', url: 'https://a.test/x' }, /cache:.*0 requestów/],
    [{ stage: 'resolve', type: 'archived', url: 'https://a.test/x', canonical: 'https://web.archive.org/web/x' }, /archiwum:/],
    [{ stage: 'falsify', type: 'fallback', coverage: 0.2, threshold: 0.35 }, /uciekam do SERP/],
    [{ stage: 'learn', type: 'learn-done', entries: 3 }, /nauka:/],
    [{ stage: 'final', type: 'final', result: { results: [], stats: {} } }, /.+/],
  ];
  for (const [ev, re] of cases) {
    const text = narrate(ev);
    assert.ok(re.test(text), `narrate(${ev.type}) = "${text}"`);
  }
});

test('narrate: puste wyniki sa legalna odpowiedzia, nie blad', () => {
  assert.match(narrate({ stage: 'falsify', type: 'fallback-done', count: 0, note: 'brak trafien' }), /SERP: 0 trafień/);
});
