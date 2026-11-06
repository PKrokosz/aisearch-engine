/**
 * web/pipeline.mjs — AiSearch: ORKIESTRATOR.
 *
 * Spinie wszystkie moduły w zamknięty ekosystem  in → AiSearch → out:
 *
 *   plan → propose → resolve → falsify → rank → [escape hatch] → learn → out
 *
 * Dwa ważne mechanizmy, które tu powstają:
 *
 * 1. STRUMIEŃ ZDARZEŃ (async generator). Każdy etap emituje zdarzenie,
 *    więc dashboard może rysować postęp NA ŻYWO, a tekstowy tryb — logować
 *    to samo w języku naturalnym (narrate()). Jeden zapis, dwa widoki.
 *
 * 2. RÓWNOLEGŁOŚĆ tam, gdzie można: odświeżenie feedów startuje w tle
 *    (nie blokuje requestu), a źródła kandydatów (inline/llm/feeds)
 *    startują jednocześnie — wolny proposer nie trzyma szybkiego.
 *
 * UCZENIE SIĘ dzieje na końcu każdego zapytania: linklog → prior → drift.
 * To jest zamknięta pętla pomysłu A, ale ucząca się ŹRÓDEŁ, nie trafionych URL-i.
 */

import { planQuery, describePlan } from './plan.mjs';
import { proposeCandidates } from './propose.mjs';
import { resolveCandidates } from './resolve.mjs';
import { scoreCandidate, coverageOf } from './falsify.mjs';
import { serpSearch } from './serp.mjs';
import { FeedIndex } from './feedindex.mjs';
import { WebCache } from './cache.mjs';
import { renderPass } from '../browser/render.mjs';
import { loadWebConfig, normalizeUrlKey, domainOf } from './types.mjs';
import {
  appendLinkLog,
  computePrior,
  priorIndex,
  detectDrift,
  linkLogEntry,
  readLinkLog,
  writePrior,
} from './learn.mjs';

/** Zdarzenie → zdanie w języku naturalnym (dla dashboardu i logów tekstowych). */
export function narrate(ev) {
  const url = (u) => String(u || '').replace(/^https?:\/\//, '').slice(0, 60);
  switch (ev.type) {
    case 'start':
      return `szukam: "${String(ev.query).slice(0, 70)}"`;
    case 'plan-done':
      return `plan: ${ev.summary}`;
    case 'propose-source':
      return `propozycja ${ev.by}: ${ev.count} kandydatów`;
    case 'propose-done':
      return `kandydaci gotowi: ${ev.count} (z ${Object.keys(ev.sources || {}).length} źródeł)`;
    case 'cache-hit':
      return `cache: ${url(ev.url)} — 0 requestów`;
    case 'request':
      return `pobieram: ${url(ev.url)}`;
    case 'resolved':
      return ev.repaired
        ? `naprawione: ${url(ev.url)} → ${url(ev.canonical)}${ev.redirects ? ` (${ev.redirects}× redirect)` : ''}`
        : `trafione: ${url(ev.url)}`;
    case 'dead':
      return `odrzucone: ${url(ev.url)} → ${ev.status ?? 'brak'}`;
    case 'error':
      return `błąd sieci: ${url(ev.url)}`;
    case 'archived':
      return `archiwum: ${url(ev.url)} → ${url(ev.canonical)}`;
    case 'stale':
      return `sieć padła — używam zapamiętanej wartości`;
    case 'rendered':
      return `render: ${url(ev.canonical || ev.url)} — ${ev.textLength} znaków z V8`;
    case 'render-skip':
      return `render: ${url(ev.url)} — przeglądarka nie dodała treści`;
    case 'render-error':
    case 'render-budget':
      return ev.message;
    case 'budget':
      return `budżet requestów wyczerpany`;
    case 'resolve-done':
      return ev.message;
    case 'falsify-done':
      return `werdykt: ${ev.kept}/${ev.verified} przechodzi próg ${ev.threshold}`;
    case 'fallback':
      return `pokrycie ${ev.coverage} < ${ev.threshold} — uciekam do SERP`;
    case 'fallback-done':
      return ev.count > 0 ? `SERP: +${ev.count} kandydatów` : `SERP: 0 trafień (${ev.note || ''})`;
    case 'learn-done':
      return `nauka: ${ev.entries} wpisów do linklogu, prior przeliczony`;
    case 'fallback-need':
      return `pokrycie za niskie (${ev.coverage}) i SERP niedostępny — zwracam co mam`;
    default:
      return ev.message || ev.type || '';
  }
}

export class AiSearch {
  /**
   * @param {object} options
   * @param {string} options.cacheDir katalog stanu (mcp/.cache/web)
   * @param {string} options.logFile  linklog.jsonl
   * @param {string} options.priorFile prior.json
   */
  constructor({ cfg = loadWebConfig(), cacheDir, logFile, priorFile, fetcher = globalThis.fetch, renderer = null } = {}) {
    this.cfg = cfg;
    this.fetcher = fetcher;
    this.renderer = renderer; // opcjonalny BrowserRenderer (Obscura); null = brak renderowania
    this.cacheDir = cacheDir;
    this.logFile = logFile;
    this.priorFile = priorFile;
    this.cache = new WebCache(cacheDir);
    this.feeds = null;
    this.prior = [];
    this.priorIdx = new Map();
    this.ready = false;
    this.history = []; // ostatnie wyniki (do statystyk sesji)
  }

  /** Inicjalizacja: cache + feedy + prior z linklogu. */
  async init({ forceFeeds = false } = {}) {
    await this.cache.load();
    this.feeds = new FeedIndex({ cache: this.cache, cfg: this.cfg, fetcher: this.fetcher });
    await this.reloadPrior();
    this.ready = true;
    // Tło: odświeżenie feedów poza ścieżką requestu (indeks żyje → nie czekamy).
    void this.feeds.refreshIfStale({ force: forceFeeds }).catch(() => {});
    return this;
  }

  /** Przelicz prior z linklogu. */
  async reloadPrior() {
    const entries = await readLinkLog(this.logFile, this.cfg.learnWindow);
    this.prior = computePrior(entries, { window: this.cfg.learnWindow });
    this.priorIdx = priorIndex(this.prior);
    await writePrior(this.priorFile, this.prior);
    return this.prior;
  }

  /**
   * Przeprowadź cały pipeline jako generator zdarzeń.
   * Ostatnie zdarzenie ma type 'final' i nosi wynik.
   */
  async *run(spec) {
    if (!this.ready) await this.init();
    const started = Date.now();
    let serpEventsDone = [];

    // 1. PLAN
    const plan = planQuery(spec, this.cfg);
    yield { stage: 'plan', type: 'plan-done', summary: describePlan(plan) };

    // Tło: feedy odświeżają się równolegle z resztą pipeline'u.
    void this.feeds.refreshIfStale().catch(() => {});

    // 2. PROPOSE (równoległe źródła — wolny proposer nie trzyma szybkiego)
    const proposeEvents = [];
    const proposed = await proposeCandidates({
      plan,
      ctx: {
        cfg: this.cfg,
        cache: this.cache,
        prior: this.prior,
        priorIndex: this.priorIdx,
        feedIndex: this.feeds,
        inlineUrls: spec.urls,
        onEvent: (ev) => proposeEvents.push(ev),
      },
    }).catch((err) => ({ candidates: [], sources: {}, notes: [`propose padł: ${err.message}`] }));
    for (const ev of proposeEvents) {
      if (ev.type !== 'start') yield { ...ev };
    }
    yield { stage: 'propose', type: 'propose-done', count: proposed.candidates.length, sources: proposed.sources, notes: proposed.notes };

    // 3. RESOLVE (równolegle, limity, single-flight, auto-korektor)
    const resolveEvents = [];
    const resolved = await resolveCandidates(proposed.candidates, {
      cfg: this.cfg,
      cache: this.cache,
      fetcher: this.fetcher,
      onEvent: (ev) => resolveEvents.push(ev),
    });
    for (const ev of resolveEvents) {
      if (ev.type !== 'start' && ev.type !== 'done') yield { ...ev };
    }
    const resolveDone = resolveEvents.find((e) => e.type === 'done');
    yield resolveDone || { stage: 'resolve', type: 'resolve-done', message: 'brak kandydatów do rozwiązania' };

    // 3b. RENDER — eskalacja do przeglądarki (Obscura). Gdy renderer nie jest
    // podłączony (replay, testy offline, domyślna konfiguracja) — zero pracy,
    // zero requestów, determinizm zachowany.
    const renderMode = spec.render || (this.renderer ? 'auto' : 'off');
    let renderStats = { rendered: 0, skipped: 0, errors: 0, budget: 0 };
    if (this.renderer) {
      const renderEvents = [];
      renderStats = await renderPass(resolved, {
        renderer: this.renderer,
        cfg: this.cfg,
        mode: renderMode,
        onEvent: (ev) => renderEvents.push(ev),
      });
      for (const ev of renderEvents) yield ev;
    }

    // 4. FALSIFY + RANK
    const verified = resolved.filter((r) => r.ok && r.httpStatus === 200);
    const scored = verified
      .map((r) => ({
        ...r,
        ...scoreCandidate(
          {
            query: plan.query,
            intent: r.intent,
            title: r.title || r.serpTitle || '',
            text: r.text || '',
            publishedMs: r.publishedMs || null,
            latencyMs: r.latencyMs || 0,
            staleness: plan.staleness,
          },
          { minScore: plan.thresholds.minScore }
        ),
      }))
      .sort((a, b) => b.score - a.score);
    const kept = scored.filter((s) => s.ok);
    const coverage = coverageOf(kept, plan.thresholds);
    yield { stage: 'falsify', type: 'falsify-done', kept: kept.length, verified: verified.length, threshold: plan.thresholds.minScore, coverage: coverage.score };

    // 5. ESCAPE HATCH (tylko gdy pokrycie za niskie)
    let externalResolved = [];
    if (coverage.needFallback && this.cfg.serpEnabled) {
      yield { stage: 'falsify', type: 'fallback', coverage: coverage.score, threshold: plan.thresholds.coverage };
      const serp = await serpSearch(plan.query, { cfg: this.cfg, fetcher: this.fetcher, planIntents: plan.intents });
      if (serp.candidates.length) {
        // ZDARZENIA SERP nie sa wyrzucane: resolve SERP to realne requesty
        // i musza byc widoczne w dashboardzie i w licznikach.
        const serpEvents = [];
        externalResolved = await resolveCandidates(serp.candidates, {
          cfg: this.cfg,
          cache: this.cache,
          fetcher: this.fetcher,
          onEvent: (ev) => serpEvents.push(ev),
        });
        for (const ev of serpEvents) {
          if (ev.type !== 'start') yield { ...ev };
        }
        const serpScored = externalResolved
          .filter((r) => r.ok && r.httpStatus === 200)
          .map((r) => ({
            ...r,
            ...scoreCandidate(
              { query: plan.query, intent: r.intent, title: r.serpTitle || r.title || '', text: r.text || '', publishedMs: r.publishedMs, latencyMs: r.latencyMs || 0, staleness: plan.staleness },
              { minScore: plan.thresholds.minScore }
            ),
          }));
        const merged = [...kept, ...serpScored].sort((a, b) => b.score - a.score);
        kept.length = 0;
        kept.push(...merged);
        yield { stage: 'falsify', type: 'fallback-done', count: serpScored.length, note: serp.note };
        serpEventsDone = serpEvents;
      } else {
        yield { stage: 'falsify', type: 'fallback-done', count: 0, note: serp.note };
      }
    } else if (coverage.needFallback) {
      yield { stage: 'falsify', type: 'fallback-need', coverage: coverage.score };
    }

    // 6. LEARN — linklog + prior + drift. Zamknięcie pętli.
    // Uwaga: kandydaci z SERP (źródło ZEWNĘTRZNE) też trafiają do nauki —
    // to łamie okrągłość uczenia się wyłącznie z własnych zgadywań.
    const logEntries = [...resolved, ...externalResolved].map((r) =>
      linkLogEntry({
        requested: r.requested || r.url,
        canonical: r.canonical,
        intent: r.intent,
        proposedBy: r.proposedBy,
        httpStatus: r.httpStatus,
        redirects: r.redirects,
        archived: r.archived,
        latencyMs: r.latencyMs,
        score: kept.find((s) => (s.canonical || s.url) === (r.canonical || r.url))?.score ?? null,
        title: r.title,
      })
    );
    await Promise.all(logEntries.map((e) => appendLinkLog(this.logFile, e)));
    await this.reloadPrior();
    const drift = detectDrift(this.prior, { threshold: this.cfg.driftRedirectRatio });
    yield { stage: 'learn', type: 'learn-done', entries: logEntries.length, drift: drift.length ? drift : null };

    // 7. OUT
    const results = kept.map((r, index) => ({
      rank: index + 1,
      url: r.canonical || r.url,
      requestedUrl: r.requested || r.url,
      title: r.title || r.serpTitle || null,
      description: (r.description || '').slice(0, 240) || null,
      publishedAt: r.publishedAt || null,
      score: r.score,
      signals: r.signals,
      intent: r.intent,
      proposedBy: r.proposedBy,
      repaired: (r.redirects || 0) > 0 || r.archived === true,
      redirects: r.redirects || 0,
      archived: r.archived === true,
      fromCache: r.fromCache === true,
      rendered: r.rendered === true,
      domain: domainOf(r.canonical || r.url),
    }));

    const final = {
      ok: true,
      query: plan.query,
      intents: plan.intents,
      staleness: plan.staleness,
      results,
      empty: results.length === 0,
      coverage: coverage.score,
      coverageReason: coverage.reason,
      fallbackUsed: kept.some((r) => r.proposedBy === 'serp'),
      stats: {
        candidates: proposed.candidates.length + externalResolved.length,
        sources: { ...proposed.sources, ...(externalResolved.length ? { serp: externalResolved.length } : {}) },
        verified: verified.length + externalResolved.filter((r) => r.ok && r.httpStatus === 200).length,
        rejected: resolved.length + externalResolved.length - verified.length - externalResolved.filter((r) => r.ok && r.httpStatus === 200).length,
        requests: resolveEvents.filter((e) => e.type === 'request').length + serpEventsDone.filter((e) => e.type === 'request').length,
        cacheHits: resolveEvents.filter((e) => e.type === 'cache-hit').length + serpEventsDone.filter((e) => e.type === 'cache-hit').length,
        singleFlight: this.cache.resolve.stats.singleFlight,
        renders: renderStats.rendered,
        renderSkipped: renderStats.skipped,
        ms: Date.now() - started,
      },
      plan,
      notes: proposed.notes || [],
      drift: drift.length ? drift : null,
    };
    this.history.push(final);
    yield { stage: 'final', type: 'final', result: final };
  }

  /** Uproszczony dostęp: przbieg bez generowania, z opcjonalnym obserwiatorem. */
  async search(spec, { onEvent } = {}) {
    let final = null;
    for await (const ev of this.run(spec)) {
      if (onEvent) onEvent(ev);
      if (ev.type === 'final') final = ev.result;
    }
    return final;
  }

  /** Sprzężenie zwrotne B: „to mi pomogło / nie" → linklog → prior. */
  async feedback({ url, label, query = '' }) {
    if (!['used', 'opened', 'ignored', 'rejected'].includes(label)) {
      throw new Error(`label musi być jednym z: used, opened, ignored, rejected`);
    }
    const key = normalizeUrlKey(url);
    await appendLinkLog(this.logFile, {
      requested: url,
      canonical: url,
      domain: domainOf(url),
      pathShape: key,
      intent: 'any',
      proposedBy: 'human',
      httpStatus: 0,
      redirects: 0,
      archived: false,
      resolved: false,
      latencyMs: 0,
      utility: label,
      score: null,
      title: null,
      query,
    });
    await this.reloadPrior();
    return { ok: true, url, label, priorEntries: this.prior.length };
  }

  /** Stan dla dashboardu i narzędzi. */
  stats() {
    return {
      cache: this.cache.stats(),
      feeds: this.feeds ? this.feeds.snapshot() : null,
      prior: {
        entries: this.prior.length,
        top: this.prior
          .slice()
          .sort((a, b) => b.n - a.n)
          .slice(0, 12)
          .map((s) => ({ key: s.key, n: s.n, successRate: Number(s.successRate.toFixed(2)), utilityRate: Number(s.utilityRate.toFixed(2)), redirectRatio: Number(s.redirectRatio.toFixed(2)) })),
      },
      drift: detectDrift(this.prior, { threshold: this.cfg.driftRedirectRatio }),
      sessionSearches: this.history.length,
    };
  }

  async flush() {
    await this.cache.flushAll();
  }
}
