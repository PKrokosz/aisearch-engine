/**
 * web/feedindex.mjs — AiSearch: WARSTWA ŚWIEŻOŚCI (pomysł z rejestru RSS).
 *
 * Subskrypcja, nie discovery. Feed nie jest wyszukiwarką — jest jedyną warstwą,
 * która za darmo, bez anty-bota i bez ToS niesie RECENCJĘ, czego model
 * z definicji nie zna (jego wiedza ma ścianę w czasie).
 *
 * Trzy kluczowe mechanizmy:
 *   1. CONDITIONAL GET — wysyłamy ETag/Last-Modified; 304 = zero transferu.
 *   2. TŁO — odświeżenie po TTL dzieje się poza ścieżką requestu (obietnica
 *      memoizowana, więc równoległe zapytania nie dublują pracy).
 *   3. AWARYJNOŚĆ — feed padły = 0 kandydatów, nigdy awarii pipeline'u.
 *
 * Stan żyje w cache.feeds (mcp/.cache/web/feeds.json).
 */

import { normalizeUrlKey, domainOf } from './types.mjs';
import { tokenize } from './falsify.mjs';

const REGISTRY_KEY = '__registry__';

/** Domyślny rejestr kanałów — dla strefy tego projektu. Samowerifikujący:
 *  każdy feed, który nie odpowiada, wypada przy pierwszym odświeżeniu. */
export const DEFAULT_FEEDS = [
  { url: 'https://github.com/nodejs/node/releases.atom', intent: 'changelog', name: 'Node.js releases' },
  { url: 'https://github.com/php/php-src/releases.atom', intent: 'changelog', name: 'PHP releases' },
  { url: 'https://mariadb.org/feed/', intent: 'news', name: 'MariaDB' },
  { url: 'https://hnrss.org/frontpage', intent: 'news', name: 'HN front page' },
  { url: 'https://en.wikipedia.org/w/index.php?title=Special:RecentChanges&feed=rss', intent: 'reference', name: 'Wikipedia recent' },
];

/**
 * Rozszerz tokeny wariantami major.minor: '8.4.12' → '8.4', 'v20.1.2' → '20.1'.
 * Bez tego zapytanie „PHP 8.4" nie trafia w tytuł „PHP 8.4.12 Released".
 */
export function withVersionVariants(tokens) {
  const set = new Set();
  for (const t of tokens) {
    set.add(t);
    const m = String(t).match(/^v?((?:\d+\.)+\d+)$/);
    if (m) {
      const parts = m[1].split('.');
      if (parts.length > 2) set.add(parts.slice(0, 2).join('.'));
    }
  }
  return set;
}

function stripCdata(value) {
  return String(value || '').replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, '$1').trim();
}

function tagText(block, tag) {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? stripCdata(m[1]) : null;
}

function attrValue(block, tag, attr) {
  const re = new RegExp(`<${tag}[^>]*\\b${attr}=["']([^"']+)["']`, 'i');
  const m = block.match(re);
  return m ? m[1] : null;
}

function absUrl(url, base) {
  try {
    return new URL(url, base).toString();
  } catch {
    return url;
  }
}

/** Tolerancyjny parser RSS 2.0 + Atom (bez zależności npm). */
export function parseFeed(xml, feedUrl, intent) {
  const xmlText = String(xml || '');
  const out = [];
  const seen = new Set();

  const push = (title, link, publishedAt) => {
    if (!link || !/^https?:\/\//.test(link)) return;
    const key = normalizeUrlKey(link);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      title: title || null,
      link,
      publishedAt: publishedAt || null,
      publishedMs: publishedAt ? Date.parse(publishedAt) : null,
      feed: feedUrl,
      feedName: domainOf(feedUrl),
      intent: intent || null,
    });
  };

  for (const block of xmlText.match(/<item[\s\S]*?<\/item>/gi) || []) {
    push(tagText(block, 'title'), tagText(block, 'link') || attrValue(block, 'link', 'href'), tagText(block, 'pubDate') || tagText(block, 'date'));
  }

  for (const block of xmlText.match(/<entry[\s\S]*?<\/entry>/gi) || []) {
    const links = [...block.matchAll(/<link[^>]*href=["']([^"']+)["']/gi)].map((m) => m[1]);
    const alternate = links.find((l) => /text\/html|alternate/i.test(l)) || links[0];
    push(tagText(block, 'title'), alternate, tagText(block, 'updated') || tagText(block, 'published'));
  }

  return out;
}

export class FeedIndex {
  constructor({ cache, cfg, fetcher = globalThis.fetch, logger } = {}) {
    this.cache = cache;
    this.cfg = cfg;
    this.fetcher = fetcher;
    this.logger = logger || (() => {});
    this.reindexPromise = null;
    this.lastReindexAt = 0;
    this.stats = { reindexes: 0, notModified: 0, parsed: 0, failed: 0, items: 0 };
  }

  /** Rejestr kanałów — trzymany w tym samym cache'u co itemy. */
  async listFeeds() {
    await this.cache.feeds.load();
    const entry = this.cache.feeds.get(REGISTRY_KEY);
    if (entry?.feeds?.length) return entry.feeds;
    return DEFAULT_FEEDS;
  }

  async addFeed(url, { intent = 'news', name = null } = {}) {
    const feeds = [...(await this.listFeeds())];
    const key = normalizeUrlKey(url);
    if (feeds.some((f) => normalizeUrlKey(f.url) === key)) return false;
    const next = [...feeds, { url, intent, name: name || domainOf(url) }];
    this.cache.feeds.set(REGISTRY_KEY, { feeds: next });
    return true;
  }

  async removeFeed(url) {
    const key = normalizeUrlKey(url);
    const next = (await this.listFeeds()).filter((f) => normalizeUrlKey(f.url) !== key);
    this.cache.feeds.set(REGISTRY_KEY, { feeds: next });
    return true;
  }

  /**
   * Odśwież kanały — równolegle, z conditional GET.
   * Wynik strukturalny: 'ok' | 'not-modified' | 'error' | 'cached',
   * żeby padnięty kanał był liczone jako failed, a nie jako „0 itemów".
   */
  async reindex({ force = false } = {}) {
    const feeds = await this.listFeeds();
    this.stats.reindexes += 1;
    const results = await Promise.allSettled(feeds.map((feed) => this.refreshOne(feed, { force })));
    this.lastReindexAt = Date.now();
    const summary = { ok: 0, notModified: 0, failed: 0, cached: 0, items: 0 };
    for (const r of results) {
      const value = r.status === 'fulfilled' ? r.value : { kind: 'error' };
      if (value === 'cached') summary.cached += 1;
      else if (value === 'not-modified') summary.notModified += 1;
      else if (value.kind === 'error') summary.failed += 1;
      else {
        summary.ok += 1;
        summary.items += value.items || 0;
      }
    }
    return summary;
  }

  async refreshOne(feed, { force = false } = {}) {
    const key = `feed:${normalizeUrlKey(feed.url)}`;
    if (!force) {
      const fresh = this.cache.feeds.get(key);
      if (fresh) return 'cached';
    }
    const headers = { accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' };
    const prev = this.cache.feeds.get(key) || this.cache.feeds.getStale(key);
    if (prev?.etag) headers['if-none-match'] = prev.etag;
    if (prev?.lastModified) headers['if-modified-since'] = prev.lastModified;

    // memo: dwa równoległe odświeżenia tego samego kanału = jedno pobranie
    return this.cache.feeds.memo(key, async () => {
      try {
        const res = await this.fetcher(feed.url, { headers, signal: AbortSignal.timeout(this.cfg.timeoutMs) });
        if (res.status === 304) {
          // 304 znaczy: „twoja kopia jest aktualna" — MUSIMY czytać kopię STALE,
          // nie świeżą. Czytanie get() (świeżej) przy wygasłym wpisie czyściło
          // itemy i etag, czyli wyłączało conditional GET na zawsze.
          this.stats.notModified += 1;
          const stale = this.cache.feeds.getStale(key) || {};
          this.cache.feeds.set(
            key,
            {
              feedUrl: feed.url,
              intent: feed.intent,
              name: feed.name || null,
              etag: stale.etag || null,
              lastModified: stale.lastModified || null,
              items: stale.items || [],
              fetchedAt: stale.fetchedAt || null,
              checkedAt: Date.now(),
            },
            { ttl: this.cfg.feedRefreshMs }
          );
          return 'not-modified';
        }
        if (res.status !== 200) {
          // Błąd nigdy nie niszczy indeksu — serwujemy to, co mamy.
          this.stats.failed += 1;
          const stale = this.cache.feeds.getStale(key) || {};
          this.cache.feeds.set(
            key,
            { ...stale, feedUrl: feed.url, error: `HTTP ${res.status}`, checkedAt: Date.now() },
            { ttl: this.cfg.feedRefreshMs }
          );
          return { kind: 'error', items: stale.items?.length || 0 };
        }
        const xml = (await res.text()) || '';
        const items = parseFeed(xml, feed.url, feed.intent).slice(0, this.cfg.feedMaxItems);
        this.stats.parsed += 1;
        this.stats.items += items.length;
        this.cache.feeds.set(key, {
          feedUrl: feed.url,
          intent: feed.intent,
          name: feed.name || null,
          etag: res.headers?.get?.('etag') || null,
          lastModified: res.headers?.get?.('last-modified') || null,
          items,
          fetchedAt: Date.now(),
          checkedAt: Date.now(),
        });
        return { kind: 'ok', items: items.length };
      } catch (err) {
        this.stats.failed += 1;
        return { kind: 'error', items: 0 };
      }
    });
  }

  /** Wszystkie itemy ze wszystkich kanałów (do match i do inspekcji). */
  allItems() {
    const items = [];
    for (const [key, entry] of this.cache.feeds.map.entries()) {
      if (key === REGISTRY_KEY || !Array.isArray(entry.items)) continue;
      for (const item of entry.items) items.push(item);
    }
    return items;
  }

  /**
   * Dopasowanie itemów do zapytania — warstwa świeżości w propose.
   * Tokeny wersyjne dopasowujemy po major.minor: zapytanie „PHP 8.4" musi
   * trafiać w tytuł „PHP 8.4.12 Released!" (inaczej overlap wynosi 0.33 i
   * wypada tuń pod próg 0.34).
   */
  match({ query, intent, limit = 5 }) {
    const qTokens = withVersionVariants(tokenize(query));
    if (!qTokens.size) return [];
    const scored = [];
    for (const item of this.allItems()) {
      if (intent && item.intent && item.intent !== intent) continue;
      const titleTokens = withVersionVariants(tokenize(item.title));
      if (!titleTokens.size) continue;
      let hit = 0;
      for (const t of qTokens) if (titleTokens.has(t)) hit += 1;
      const overlap = hit / qTokens.size;
      if (overlap >= 0.34) {
        scored.push({
          ...item,
          overlap: Number(overlap.toFixed(3)),
          score: Number((overlap * 0.8 + (item.publishedMs ? 0.2 : 0)).toFixed(3)),
        });
      }
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /**
   * Odświeżenie w tle: jeśli indeks jest pusty lub przestażony — czekamy
   * (bo bez itemów propose nie ma warstwy świeżości). Jeśli indeks żyje —
   * startujemy obietnicę i NIE czekamy: request idzie dalej natychmiast.
   */
  async refreshIfStale({ force = false } = {}) {
    const items = this.allItems();
    const stale = force || items.length === 0 || Date.now() - this.lastReindexAt > this.cfg.feedRefreshMs;
    if (!stale) return items.length;
    this.reindexPromise = this.reindexPromise || this.reindex({ force }).finally(() => { this.reindexPromise = null; });
    // pusty indeks = czekamy, bo inaczej etap propose nie ma co dać
    if (items.length === 0) await this.reindexPromise;
    return items.length;
  }

  snapshot() {
    const feeds = [];
    for (const [key, entry] of this.cache.feeds.map.entries()) {
      if (key === REGISTRY_KEY || !entry.feedUrl) continue;
      feeds.push({
        url: entry.feedUrl,
        items: Array.isArray(entry.items) ? entry.items.length : 0,
        etag: entry.etag || null,
        error: entry.error || null,
        lastFetch: entry.fetchedAt ? new Date(entry.fetchedAt).toISOString() : null,
      });
    }
    return { registered: feeds.length, feeds, ...this.stats };
  }
}
