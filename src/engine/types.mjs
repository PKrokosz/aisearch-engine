/**
 * web/types.mjs — AiSearch: słownictwo, kontrakty, normalizacja, konfiguracja.
 *
 * Ten moduł nie wykonuje żadnych operacji sieciowych. Jest wspólnym językiem
 * pozostałych modułów (plan → propose → resolve → falsify → learn).
 * Dzięki temu każdy etap jest testowalny osobno.
 */

/** Typy intencji — każda ma inną rodzinę źródeł i inną wagę w rankingu. */
import { join } from 'node:path';

export const INTENT_TYPES = [
  'official-docs',
  'changelog',
  'advisory',
  'repo',
  'discussion',
  'news',
  'reference',
  'local-pl',
];

/** Producenci kandydatów URL (źródła hipotez). */
export const PROPOSERS = ['inline', 'llm', 'feeds', 'prior', 'serp'];

/** Etykiety użyteczności z pętli sprzężenia zwrotnego. */
export const UTILITY_LABELS = ['used', 'opened', 'ignored', 'rejected'];

/** Tolerancja świeżości w ms. */
export const STALENESS_MS = {
  fresh: 24 * 3600 * 1000, // 1 doba
  recent: 7 * 24 * 3600 * 1000, // 7 dni
  any: 0, // bez kary za wiek
};

/** Domyślne progi i wagi scoringu. */
export const SCORE_WEIGHTS = {
  title: 0.55,
  content: 0.2,
  freshness: 0.15,
  speed: 0.1,
};

/** Rodziny źródeł per intencja — używane przez plan i uczący się prior. */
export const SOURCE_FAMILIES = {
  'official-docs': ['developer.mozilla.org', 'docs.python.org', 'nodejs.org', 'www.php.net', 'mariadb.com', 'kubernetes.io'],
  changelog: ['github.com', 'nodejs.org', 'www.php.net', 'mariadb.org', 'releases'],
  advisory: ['nvd.nist.gov', 'www.cisa.gov', 'github.com/advisories', 'wordfence.com', 'wpscan.com'],
  repo: ['github.com', 'gitlab.com', 'packagist.org', 'registry.npmjs.org'],
  discussion: ['stackoverflow.com', 'serverfault.com', 'www.reddit.com', 'github.com'],
  news: ['news.ycombinator.com', 'devclass.com', 'theregister.com'],
  reference: ['en.wikipedia.org', 'pl.wikipedia.org'],
  // 'local-pl' — własne źródła operatora. Puste domyślnie; konfigurowalne bez
  // forkowania kodu: WEB_SOURCE_LOCAL="twoja-domena.pl,blog.twoja-domena.pl".
  'local-pl': String(process.env.WEB_SOURCE_LOCAL || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
};

/**
 * Znormalizuj URL do klucza cache'u i logu.
 * Małe litery hosta, bez www, bez trailing slash, posortowane parametry.
 */
export function normalizeUrlKey(input) {
  try {
    const p = new URL(input);
    let host = p.hostname.toLowerCase().replace(/^www\./, '');
    let path = p.pathname.replace(/\/+$/, '') || '/';
    const params = [...p.searchParams.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]))
      .map(([k, v]) => `${k}=${v}`);
    const q = params.length ? `?${params.join('&')}` : '';
    return `${p.protocol}//${host}${path}${q}`;
  } catch {
    return String(input || '');
  }
}

/** Domena znormalizowana (bez www, małe litery). */
export function domainOf(input) {
  try {
    return new URL(input).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * Kształt ścieżki do uczenia się na poziomie wzorca, nie dokładnego URL-u.
 * Segments liczbowe → :num, długie/pliki → :seg. Zapobiega uczeniu się
 * „ten konkretny URL żył" (co gnije w tygodnie) na rzecz „taka struktura ścieżki
 * na tej domenie działa".
 */
export function pathShapeOf(input) {
  try {
    const p = new URL(input);
    if (!p.pathname || p.pathname === '/') return '/';
    return p.pathname
      .split('/')
      .filter(Boolean)
      .map((s) => {
        if (/^\d+$/.test(s)) return ':num';
        if (/^v?\d+(\.\d+){0,2}$/.test(s)) return ':ver';
        if (/\.(html?|php|md|json|xml)$/.test(s) || s.length > 24) return ':seg';
        return s.toLowerCase();
      })
      .join('/');
  } catch {
    return '';
  }
}

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Katalog `mcp/` wyliczany z położenia TEGO pliku (mcp/src/web/types.mjs).
 * JEDNO miejsce w całym ekosystemie — moduły nigdy nie zgadują ścieżki same.
 * Wcześniej trzy pliki liczyły `dirname(dirname(...))` (co daje `mcp/src`),
 * przez co MCP i mostek HTTP pisałyby do `mcp/src/.cache` zamiast `mcp/.cache`.
 */
export const MCP_DIR = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
export const DEFAULT_CACHE_DIR = join(MCP_DIR, '.cache', 'web');

/**
 * Rozwiąż konfigurację AiSearch ze zmiennych środowiskowych (.env w mcp/).
 * Każda wartość ma domyślną, więc brak .env nie jest błędem.
 */
export function loadWebConfig(env = process.env) {
  const num = (raw, dflt) => {
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : dflt;
  };
  return {
    // producenci kandydatów
    proposers: String(env.WEB_PROPOSERS || 'inline,feeds,prior')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => PROPOSERS.includes(s)),
    llm: {
      url: (env.WEB_LLM_URL || env.WEB_LLM_BASE_URL || '').replace(/\/+$/, ''),
      key: env.WEB_LLM_KEY || '',
      model: env.WEB_LLM_MODEL || '',
    },
    // escape hatch
    serpProvider: env.WEB_SERP_PROVIDER || 'ddg-html',
    serpEndpoint: env.WEB_SERP_ENDPOINT || '',
    serpKey: env.WEB_SERP_KEY || '',
    serpEnabled: String(env.WEB_SERP_ENABLED || 'true') !== 'false',
    // budżety requestów
    maxRequests: num(env.WEB_MAX_REQUESTS, 24),
    concurrency: Math.max(1, Math.min(16, num(env.WEB_CONCURRENCY, 6))),
    timeoutMs: num(env.WEB_TIMEOUT_MS, 10000),
    coverageThreshold: Math.min(1, Math.max(0, Number(env.WEB_COVERAGE_THRESHOLD || 0.35))),
    // cache
    cacheDir: env.WEB_CACHE_DIR || '',
    resolveTtlMs: num(env.WEB_CACHE_RESOLVE_TTL_MS, 6 * 3600 * 1000),
    negativeTtlMs: num(env.WEB_CACHE_NEGATIVE_TTL_MS, 15 * 60 * 1000),
    contentTtlMs: num(env.WEB_CACHE_CONTENT_TTL_MS, 24 * 3600 * 1000),
    contentMaxEntries: num(env.WEB_CACHE_CONTENT_MAX, 2000),
    // feedy
    feedRefreshMs: num(env.WEB_FEED_REFRESH_MS, 30 * 60 * 1000),
    feedMaxItems: num(env.WEB_FEED_MAX_ITEMS, 200),
    // nauka / drift
    learnWindow: num(env.WEB_LEARN_WINDOW, 5000),
    driftRedirectRatio: Math.min(1, Math.max(0, Number(env.WEB_DRIFT_REDIRECT_RATIO || 0.25))),
    waybackEnabled: String(env.WEB_WAYBACK_ENABLED || 'true') !== 'false',
    // renderowanie (warstwa przeglądarki — Obscura). Sam config NIE włącza
    // renderera: pipeline dostaje go z zewnątrz (this.renderer). Te flagi mówią
    // JAK renderować, gdy renderer istnieje.
    renderMinText: num(env.WEB_RENDER_MIN_TEXT, 200),
    renderMax: num(env.WEB_RENDER_MAX, 3),
    renderTimeoutMs: num(env.WEB_RENDER_TIMEOUT_MS, 15000),
  };
}

/** Domyślny katalog cache'u — mcp/.cache/web (gitignored). */
export function defaultCacheDir(mcpDir) {
  return mcpDir;
}
