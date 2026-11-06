/**
 * web/resolve.mjs — AiSearch etap 3: AUTO-KOREKTOR (serce pomysłu A).
 *
 * Serwer jest rozjemcą. Tu dzieje się cała asynchroniczność:
 *
 *   1. RÓWNOLEGLE     — kandydaci idzie równolegle z limitem współbieżności.
 *                       Eksperyment: 6 linków × ~200-1150 ms. Sekwencyjnie
 *                       ~2,5 s, równolegle ~1,2 s.
 *   2. POJEDYNCZY LOT — ten sam kandydat zgłoszony współbieżnie = JEDEN request
 *                       (single-flight w cache.mjs).
 *   3. UPRZEJMOŚĆ    — minimalny odstęp per host, żeby anty-bot nie błysnął.
 *   4. TŁO            — feedindex odświeża się poza ścieżką requestu (feedindex.mjs).
 *
 * Architektura „zgadywania": proponuj URL → HTTP go koryguje.
 *   301/302 naprawiła złą ścieżkę MDN w eksperymencie (220 ms, zero dodatkowych
 *   requestów) — redirect jest najtańszym korektorem jaki istnieje.
 *   Warianty są awaryjne, Wayback ocala martwe linki.
 * Metadane (tytuł, opis, data) wyciągamy z TEJ SAMEJ odpowiedzi — zero zbędnych requestów.
 */

import { normalizeUrlKey, domainOf } from './types.mjs';
import { extractMeta, htmlToText } from './falsify.mjs';

const MAX_HOPS = 4;
const MAX_VARIANTS = 3;

function emit(onEvent, event) {
  if (typeof onEvent === 'function') {
    try {
      onEvent(event);
    } catch {
      /* obserwator nigdy nie może wysypać pipeline'u */
    }
  }
}

/** Brama per host: minimalny odstęp między requestami do tej samej domeny. */
export class HostGate {
  constructor(minIntervalMs = 250) {
    this.min = Math.max(0, minIntervalMs);
    this.last = new Map();
  }
  async wait(host) {
    if (!this.min || !host) return;
    const now = Date.now();
    const last = this.last.get(host) || 0;
    const delay = last + this.min - now;
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    this.last.set(host, Date.now());
  }
}

/**
 * Rodziny wariantów URL-u (awaryjne, gdy redirect nie pomoże):
 *   - github.com/o/r/blob/… → raw.githubusercontent.com (mniejsza odpowiedź)
 *   - http → https
 *   - ścieżka z trailing slash ↔ bez
 */
export function variantFamilies(url, max = MAX_VARIANTS) {
  const out = [String(url)];
  try {
    const p = new URL(url);
    const blob = p.pathname.match(/^\/([^/]+)\/([^/]+)\/blob\/(.+)$/);
    if (p.hostname === 'github.com' && blob) {
      out.push(`https://raw.githubusercontent.com/${blob[1]}/${blob[2]}/${blob[3]}`);
    }
    if (p.protocol === 'http:') {
      out.push(`https://${p.host}${p.pathname}${p.search}`);
    } else if (p.pathname.length > 1) {
      out.push(p.pathname.endsWith('/') ? p.pathname.replace(/\/+$/, '') : `${p.pathname}/`);
      out[out.length - 1] = new URL(out[out.length - 1], p).toString();
    }
  } catch {
    /* nieparsowalny URL — tylko jeden wariant */
  }
  return [...new Set(out)].slice(0, max);
}

/**
 * Ręczny chód przez przekierowania — dzięki temu ZNAMY liczbę hopów
 * (redirect_ratio do detektora driftu) i kanoniczny URL finalny.
 */
async function walkRedirects(fetcher, url, { headers = {}, signal } = {}) {
  const chain = [];
  let current = url;
  for (let hop = 0; hop <= MAX_HOPS; hop += 1) {
    const res = await fetcher(current, { redirect: 'manual', headers, signal });
    const location = res.headers?.get?.('location') || null;
    chain.push({ status: res.status, url: current, to: location });
    if (res.status >= 300 && res.status < 400 && location) {
      current = new URL(location, current).toString();
      continue;
    }
    return { url: current, status: res.status, hops: chain.length - 1, chain, readText: () => res.text() };
  }
  return { url: current, status: 310, hops: MAX_HOPS, chain, readText: async () => '' };
}

/** Resolve jednego kandydata: warianty → redirect → Wayback → negatywny cache. */
async function resolveOne(candidate, ctx) {
  const key = normalizeUrlKey(candidate.url);
  const variants = variantFamilies(candidate.url);
  let lastStatus = 0;
  let lastError = null;
  const t0 = Date.now();

  for (const variant of variants) {
    if (ctx.count() >= ctx.cfg.maxRequests) {
      emit(ctx.onEvent, { stage: 'resolve', type: 'budget', url: candidate.url, message: `budzet requestow wyczerpany (${ctx.cfg.maxRequests})` });
      break;
    }
    ctx.increment();
    emit(ctx.onEvent, { stage: 'resolve', type: 'request', url: variant, requested: candidate.url, host: domainOf(variant) });

    await ctx.gate.wait(domainOf(variant));
    try {
      const result = await walkRedirects(ctx.fetcher, variant, {
        headers: { accept: 'text/html,application/xhtml+xml,*/*', 'user-agent': ctx.userAgent },
        signal: AbortSignal.timeout(ctx.cfg.timeoutMs),
      });
      const latencyMs = Date.now() - t0;
      const last = result.chain[result.chain.length - 1];
      lastStatus = last.status;

      if (result.status === 200) {
        const html = (await result.readText()) || '';
        const meta = extractMeta(html, result.url);
        const text = htmlToText(html);
        const canonical = meta.canonical ? new URL(meta.canonical, result.url).toString() : result.url;
        const entry = {
          requested: candidate.url,
          canonical,
          httpStatus: 200,
          ok: true,
          redirects: result.hops,
          archived: false,
          intent: candidate.intent,
          proposedBy: candidate.proposedBy,
          confidence: candidate.confidence ?? null,
          reason: candidate.reason ?? null,
          title: meta.title,
          description: meta.description,
          publishedAt: meta.publishedAt,
          publishedMs: meta.publishedMs,
          text,
          latencyMs,
          fetchedAt: Date.now(),
        };
        ctx.cache.resolve.set(key, entry);
        ctx.cache.content.set(normalizeUrlKey(canonical), entry);
        emit(ctx.onEvent, {
          stage: 'resolve',
          type: 'resolved',
          url: candidate.url,
          canonical,
          redirects: result.hops,
          latencyMs,
          repaired: result.hops > 0 || canonical !== candidate.url,
          message: `${candidate.url} → ${canonical}${result.hops > 0 ? ` (${result.hops} przekierowan)` : ''}`,
        });
        return { ...candidate, ...entry, fromCache: false };
      }

      if (result.status === 404 || result.status === 0) {
        emit(ctx.onEvent, { stage: 'resolve', type: 'dead', url: variant, status: result.status, message: `${variant} → ${result.status} (zgadnięcie odrzucone)` });
      }
    } catch (err) {
      lastError = err;
      emit(ctx.onEvent, { stage: 'resolve', type: 'error', url: variant, message: `${variant} → ${String(err?.message || err).slice(0, 80)}` });
    }
  }

  // Wayback: „martwy link" → „archiwalny link", bez kosztu i bez anty-bota
  if (ctx.cfg.waybackEnabled && ctx.count() < ctx.cfg.maxRequests) {
    ctx.increment();
    try {
      const r = await ctx.fetcher(`https://archive.org/wayback/available?url=${encodeURIComponent(candidate.url)}`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(ctx.cfg.timeoutMs),
      });
      const body = await r.json();
      const snap = body?.archived?.closest?.url;
      if (snap) {
        const entry = {
          requested: candidate.url,
          canonical: snap,
          httpStatus: 200,
          ok: true,
          redirects: 0,
          archived: true,
          intent: candidate.intent,
          proposedBy: candidate.proposedBy,
          title: null,
          description: null,
          publishedAt: body?.archived?.closest?.timestamp || null,
          publishedMs: null,
          text: '',
          latencyMs: Date.now() - t0,
          fetchedAt: Date.now(),
        };
        ctx.cache.resolve.set(key, entry);
        emit(ctx.onEvent, { stage: 'resolve', type: 'archived', url: candidate.url, canonical: snap, message: `${candidate.url} → kopia Wayback` });
        return { ...candidate, ...entry, fromCache: false };
      }
    } catch {
      /* Wayback opcjonalny — brak odpowiedzi to nie awaria */
    }
  }

  // Stale-while-error: pad sieci ≠ pusta odpowiedź. Starą wartość służymy ze znacznikiem.
  const stale = ctx.cache.resolve.getStale(key);
  if (stale && stale.httpStatus === 200) {
    emit(ctx.onEvent, { stage: 'resolve', type: 'stale', url: candidate.url, message: 'sieć padła — serwuję zapamiętaną wartość (stale)' });
    return { ...candidate, ...stale, stale: true, fromCache: true };
  }

  const entry = {
    requested: candidate.url,
    canonical: null,
    httpStatus: lastStatus || 0,
    ok: false,
    redirects: 0,
    archived: false,
    intent: candidate.intent,
    proposedBy: candidate.proposedBy,
    error: lastError ? String(lastError.message || lastError).slice(0, 120) : `HTTP ${lastStatus || 'blad sieci'}`,
    latencyMs: Date.now() - t0,
    fetchedAt: Date.now(),
  };
  ctx.cache.resolve.set(key, entry);
  emit(ctx.onEvent, { stage: 'resolve', type: 'rejected', url: candidate.url, message: `${candidate.url} odrzucony (${entry.error})` });
  return { ...candidate, ...entry, fromCache: false };
}

/**
 * Rozwiąż listę kandydatów równolegle.
 * @returns {Promise<Array>} Resolved[] — zawsze tej samej długości co wejście.
 */
export async function resolveCandidates(candidates, { cfg, cache, fetcher = globalThis.fetch, onEvent, hostGateMs = 250, userAgent = 'AiSearch/1.0 (+https://pkrokosz.pl)' } = {}) {
  if (!Array.isArray(candidates) || !candidates.length) return [];
  const ctx = {
    cfg,
    cache,
    fetcher,
    onEvent,
    gate: new HostGate(hostGateMs),
    userAgent,
    requests: 0,
    count: () => ctx.requests,
    increment: () => { ctx.requests += 1; },
  };

  emit(onEvent, { stage: 'resolve', type: 'start', count: candidates.length, concurrency: cfg.concurrency, message: `start: ${candidates.length} kandydatów, ${cfg.concurrency} równolegle` });

  const running = new Set();
  const results = new Array(candidates.length);
  let next = 0;

  const launch = (index) => {
    const candidate = candidates[index];
    const key = normalizeUrlKey(candidate.url);
    const cached = cache.resolve.get(key);
    const work = cached
      ? Promise.resolve({
          ...candidate,
          ...cached,
          canonical: cached.canonical,
          httpStatus: cached.httpStatus ?? 0,
          fromCache: true,
        })
      : cache.resolve.memo(key, () => resolveOne(candidate, ctx));

    const promise = work
      .then((resolved) => {
        results[index] = resolved;
        if (cached) {
          emit(onEvent, { stage: 'resolve', type: 'cache-hit', url: candidate.url, message: `${candidate.url} — z cache, 0 requestów` });
        }
      })
      .catch((err) => {
        results[index] = { ...candidate, ok: false, httpStatus: 0, error: String(err?.message || err).slice(0, 120) };
        emit(onEvent, { stage: 'resolve', type: 'error', url: candidate.url, message: String(err?.message || err).slice(0, 120) });
      })
      .finally(() => running.delete(promise));

    running.add(promise);
  };

  // Scheduler: trzymaj `concurrency` aktywnych zadań, reszta czeka w kolejce.
  while (next < candidates.length || running.size > 0) {
    while (next < candidates.length && running.size < cfg.concurrency) {
      launch(next);
      next += 1;
    }
    if (running.size > 0) await Promise.race([...running]);
  }

  const resolved = results.filter(Boolean);
  const okCount = resolved.filter((r) => r.ok && r.httpStatus === 200).length;
  const repaired = resolved.filter((r) => r.ok && (r.redirects > 0 || r.archived)).length;
  emit(onEvent, {
    stage: 'resolve',
    type: 'done',
    message: `koniec: ${okCount}/${resolved.length} zweryfikowanych, ${repaired} naprawionych przez redirect/Wayback, ${ctx.count()} requestów`,
    requests: ctx.count(),
    verified: okCount,
    repaired,
  });
  return resolved;
}
