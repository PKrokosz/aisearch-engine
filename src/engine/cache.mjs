/**
 * web/cache.mjs — AiSearch: warstwa stanu (mcp/.cache/web, gitignored).
 *
 * Trzy OSOBNE magazyny, bo to trzy osobne problemy:
 *   resolve  — „ten zgadywany URL dał kiedyś 200/301/404"     TTL 6h, negatywy 15min
 *   content  — „treść i metadane kanonicznego URL-u"           TTL 24h, LRU
 *   feeds    — „itemy z kanału RSS/Atom"                       TTL per feed
 *
 * Mechanizmy: negatywny cache, LRU, single-flight (dedup współbieżności),
 * stale-while-error, debounce zapisu.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const now = () => Date.now();

/**
 * Magazyn klucz → wartość z TTL per wpis, negatywnym cache'em i LRU.
 * Zapis jest debounkowany: MCP żyje jako proces stdio, nie chcemy
 * zapisu na każdym insercie.
 */
export class TtlCache {
  constructor(name, file, options = {}) {
    this.name = name;
    this.file = file;
    this.ttl = options.ttl ?? 3600000;
    this.negativeTtl = options.negativeTtl ?? 900000;
    this.maxEntries = options.maxEntries ?? 2000;
    this.flushMs = options.flushMs ?? 250;
    this.map = new Map();
    this.inflight = new Map();
    this.loaded = false;
    this.dirty = false;
    this.timer = null;
    this.stats = { hits: 0, misses: 0, staleServes: 0, evictions: 0, writes: 0, singleFlight: 0 };
  }

  async load() {
    if (this.loaded) return;
    try {
      const txt = await readFile(this.file, 'utf8');
      const parsed = JSON.parse(txt);
      for (const [k, v] of Object.entries(parsed.entries || {})) {
        if (v && typeof v === 'object') this.map.set(k, v);
      }
    } catch {
      /* brak pliku lub uszkodzony = start od zera */
    }
    this.loaded = true;
  }

  /** Świeży wpis (lub null). */
  get(key) {
    const entry = this.map.get(key);
    if (!entry) {
      this.stats.misses += 1;
      return null;
    }
    if (entry.exp > now()) {
      entry.lastHit = now();
      this.stats.hits += 1;
      this.touch();
      return entry;
    }
    this.stats.misses += 1;
    return null;
  }

  /**
   * Wpis nawet po TTL — do stale-while-error: pad sieci ≠ pusta odpowiedź.
   * Zwracamy starą wartość ze znacznikiem stale, zamiast zgadywać od nowa.
   */
  getStale(key) {
    const entry = this.map.get(key);
    if (!entry) return null;
    entry.lastHit = now();
    this.stats.staleServes += 1;
    return { ...entry, stale: true };
  }

  /** Zapisz wartość. TTL wybierany sam: sukces → this.ttl, negatyw → this.negativeTtl. */
  set(key, value, { ttl } = {}) {
    const entry = { ...(value || {}) };
    const httpStatus = Number(entry.httpStatus ?? (entry.ok ? 200 : 0));
    const ttlMs = ttl ?? (httpStatus === 200 ? this.ttl : this.negativeTtl);
    this.map.set(key, {
      ...entry,
      httpStatus,
      exp: now() + ttlMs,
      savedAt: now(),
      lastHit: now(),
    });
    this.evictIfNeeded();
    this.touch();
    return entry;
  }

  evictIfNeeded() {
    if (this.map.size <= this.maxEntries) return;
    // LRU: wyrzuć najstarsze lastHit
    const victims = [...this.map.entries()]
      .sort((a, b) => (a[1].lastHit || 0) - (b[1].lastHit || 0))
      .slice(0, this.map.size - this.maxEntries);
    for (const [k] of victims) {
      this.map.delete(k);
      this.stats.evictions += 1;
    }
  }

  /**
   * Single-flight: współbieżne żądanie tego samego klucza = JEDEN request.
   * To sedno asynchroniczności AiSearch: bez tego równoległe zgadywania
   * tego samego URL-a mnoży requesty zamiast je scalać.
   */
  memo(key, factory) {
    const existing = this.inflight.get(key);
    if (existing) {
      this.stats.singleFlight += 1;
      return existing;
    }
    const promise = (async () => {
      try {
        return await factory();
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, promise);
    return promise;
  }

  touch() {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.flushMs);
    if (this.timer.unref) this.timer.unref();
  }

  async flush() {
    if (!this.dirty) return;
    this.dirty = false;
    const payload = { name: this.name, savedAt: new Date().toISOString(), entries: Object.fromEntries(this.map) };
    try {
      await mkdir(dirname(this.file), { recursive: true });
      await writeFile(this.file, JSON.stringify(payload), 'utf8');
      this.stats.writes += 1;
    } catch {
      /* zapis cache'u nigdy nie może wysypać pipeline'u */
    }
  }

  async flushSync() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.flush();
  }

  snapshot() {
    let live = 0;
    let expired = 0;
    for (const v of this.map.values()) {
      if (v.exp > now()) live += 1;
      else expired += 1;
    }
    return {
      name: this.name,
      entries: this.map.size,
      live,
      expired,
      inflight: this.inflight.size,
      hits: this.stats.hits,
      misses: this.stats.misses,
      staleServes: this.stats.staleServes,
      evictions: this.stats.evictions,
      singleFlight: this.stats.singleFlight,
    };
  }

  clear() {
    this.map.clear();
    this.dirty = true;
  }
}

/** Trzy magazyny + katalog + zbiorcze statystyki. */
export class WebCache {
  constructor(dir) {
    this.dir = dir;
    this.resolve = new TtlCache('resolve', `${dir}/resolve.json`, { maxEntries: 10000 });
    this.content = new TtlCache('content', `${dir}/content.json`, { maxEntries: 2000 });
    this.feeds = new TtlCache('feeds', `${dir}/feeds.json`, { maxEntries: 5000 });
  }

  async load() {
    await Promise.all([this.resolve.load(), this.content.load(), this.feeds.load()]);
  }

  async flushAll() {
    await Promise.all([this.resolve.flushSync(), this.content.flushSync(), this.feeds.flushSync()]);
  }

  stats() {
    return {
      dir: this.dir,
      resolve: this.resolve.snapshot(),
      content: this.content.snapshot(),
      feeds: this.feeds.snapshot(),
      requestsSaved: this.resolve.stats.hits + this.content.stats.hits + this.feeds.stats.hits,
    };
  }

  clearAll() {
    this.resolve.clear();
    this.content.clear();
    this.feeds.clear();
  }
}
