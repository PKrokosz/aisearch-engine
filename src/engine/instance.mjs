#!/usr/bin/env node
/**
 * engine/instance.mjs — JEDNA instancja silnika, wiele wejść.
 *
 * MCP (stdio), HTTP (serwer) i mostek (CLI stdin→stdout) używają tego samego
 * obiektu: ten sam cache, prior i historia. Zapytanie z API uczy się z tego,
 * czego nauczył się agent — i odwrotnie. To było „jeden silnik, wiele
 * interfejsów" z architektury źródłowej; tu jest w jednym miejscu.
 *
 * Renderer (Obscura) jest LENIWY: binaria sprawdzana przy starcie (tanie),
 * proces przeglądarki startuje przy pierwszym renderze — czyste web.* nie
 * płači za przeglądarkę nic.
 */
import { join } from 'node:path';

import { AiSearch, narrate } from './pipeline.mjs';
import { loadWebConfig, MCP_DIR } from './types.mjs';
import { WebCache } from './cache.mjs';
import { detectDrift } from './learn.mjs';
import { loadFixtures, buildReplayFetcher, runEval, evalGate } from './eval.mjs';
import { findObscuraBin, ObscuraClient, BrowserUnavailableError } from '../browser/client.mjs';
import { BrowserRenderer } from '../browser/render.mjs';

/** Renderer, który nie startuje przeglądarki do pierwszego renderu. */
export class LazyRenderer {
  constructor({ bin } = {}) {
    this.bin = bin;
    this.real = null;
  }

  _ensure() {
    if (!this.real) {
      this.real = new BrowserRenderer({ client: new ObscuraClient({ bin: this.bin }) });
    }
    return this.real;
  }

  renderPage(url, opts) {
    return this._ensure().renderPage(url, opts);
  }

  async close() {
    if (this.real) await this.real.close();
  }

  get client() {
    return this._ensure().client;
  }
}

export class AiSearchInstance {
  constructor({ renderer = null, cfg = loadWebConfig(process.env) } = {}) {
    this.cfg = cfg;
    this.renderer = renderer;
    this.cacheDir = cfg.cacheDir || join(MCP_DIR, '.cache', 'web');
    this.logFile = join(this.cacheDir, 'linklog.jsonl');
    this.priorFile = join(this.cacheDir, 'prior.json');
    this.instance = null;
  }

  /** Renderer leniwy — tylko gdy binaria realnie istnieją. */
  static withOptionalRenderer(cfg = loadWebConfig(process.env)) {
    const renderOff = String(process.env.WEB_RENDER || 'auto') === 'off';
    const bin = renderOff ? null : findObscuraBin();
    return new AiSearchInstance({ cfg, renderer: bin ? new LazyRenderer({ bin }) : null });
  }

  async engine() {
    if (!this.instance) {
      this.instance = new AiSearch({
        cfg: this.cfg,
        cacheDir: this.cacheDir,
        logFile: this.logFile,
        priorFile: this.priorFile,
        renderer: this.renderer,
      });
      await this.instance.init();
    }
    return this.instance;
  }

  async _run(input, { fullTrace = false } = {}) {
    const search = await this.engine();
    const trace = [];
    const result = await search.search(
      {
        query: input.query,
        urls: input.urls,
        intents: input.intents,
        staleness: input.staleness,
        limit: input.limit,
        render: input.render,
      },
      { onEvent: (ev) => trace.push(narrate(ev)) }
    );
    await search.flush();
    return {
      ok: true,
      query: result.query, intents: result.intents, results: result.results.slice(0, input.top ?? 5), coverage: result.coverage, empty: result.empty, trace: fullTrace ? trace : trace.filter(Boolean).slice(-8), stats: result.stats, notes: result.notes };
  }

  // ── tryby (ten sam kontrakt co mostek/HTTP/MCP) ─────────────────────
  async search(input) {
    return this._run(input);
  }

  async trace(input) {
    return this._run(input, { fullTrace: true });
  }

  async brief(input) {
    const res = await this._run(input);
    return {
      ok: true,
      query: res.query,
      coverage: res.coverage,
      empty: res.empty,
      brief: res.results.map((r) => ({
        rank: r.rank,
        title: r.title,
        url: r.url,
        score: r.score,
        intent: r.intent,
        domain: r.domain,
        repaired: r.repaired,
        archived: r.archived,
        rendered: r.rendered,
        fromCache: r.fromCache,
        description: r.description,
      })),
      notes: res.notes,
      stats: res.stats,
    };
  }

  async verifyLinks(input) {
    const urls = Array.isArray(input.urls) ? input.urls : [];
    const res = await this._run({ ...input, urls, top: input.top ?? urls.length ?? 5, serp: input.serp === true });
    const survived = res.results.map((r) => ({
      url: r.url,
      title: r.title,
      score: r.score,
      repaired: r.repaired,
      redirects: r.redirects,
      archived: r.archived,
      rendered: r.rendered,
    }));
    const keptKeys = ' ' + survived.map((s) => s.url).join(' ') + ' ';
    const rejected = urls
      .filter((u) => !keptKeys.includes(` ${u} `) && !keptKeys.includes(u))
      .map((u) => ({ url: u, reason: 'HTTP nie potwierdził (404/DNS) albo poniżej progu scoringu' }));
    return {
      ok: true,
      query: res.query,
      total: urls.length,
      survived,
      rejected,
      repaired: survived.filter((s) => s.repaired).map((s) => s.url),
      counts: { survived: survived.length, rejected: rejected.length, repaired: survived.filter((s) => s.repaired).length, requests: (res.stats || {}).requests ?? 0 },
    };
  }

  async driftReport(input = {}) {
    const search = await this.engine();
    const drift = detectDrift(search.prior, { threshold: input.threshold ?? search.cfg.driftRedirectRatio });
    const priorTop = search.prior
      .slice()
      .sort((a, b) => b.n - a.n)
      .slice(0, 8)
      .map((s) => ({ key: s.key, n: s.n, successRate: Number(s.successRate.toFixed(2)), redirectRatio: Number(s.redirectRatio.toFixed(2)) }));
    const verdict = drift.length
      ? `UWAGA: ${drift.length} domen/a zaczęło przekierowywać (docs się przestawiły). Sprawdź te źródła, zanim zgnosisz następny adres.`
      : `OK: żadna domena nie przekracza progu ${input.threshold ?? search.cfg.driftRedirectRatio} redirect_ratio — ekosystem jest stabilny.`;
    return { ok: true, threshold: input.threshold ?? search.cfg.driftRedirectRatio, drift, priorTop, verdict };
  }

  async render(input) {
    if (!this.renderer) throw new BrowserUnavailableError('Renderer niedostępny: brak binarii Obscury (bin/ albo OBSCURA_BIN) lub WEB_RENDER=off.');
    const out = await this.renderer.renderPage(input.url, { timeoutMs: input.timeoutMs });
    if (!out.ok) return { ok: false, url: input.url, error: out.error || 'przeglądarka nie zwróciła treści' };
    return { ok: true, url: out.url, title: out.title, text: out.text, length: out.text.length };
  }

  async feedback(input) {
    const search = await this.engine();
    const out = await search.feedback(input);
    await search.flush();
    return out;
  }

  async stats() {
    const search = await this.engine();
    return search.stats();
  }

  async drift(input = {}) {
    const search = await this.engine();
    return { threshold: input.threshold ?? search.cfg.driftRedirectRatio, drift: detectDrift(search.prior, { threshold: input.threshold ?? search.cfg.driftRedirectRatio }) };
  }

  async cache(input = {}) {
    const search = await this.engine();
    if (input.action === 'clear') {
      search.cache.clearAll();
      await search.cache.flushAll();
      return { ok: true, cleared: true };
    }
    return search.cache.stats();
  }

  async eval({ mode = 'replay', gate = false, thresholds } = {}) {
    const cfg = loadWebConfig(process.env);
    if (mode === 'replay') cfg.serpEnabled = false;
    const cache = new WebCache(join(MCP_DIR, '.cache', 'web-eval'));
    await cache.load();
    const fixtures = await loadFixtures(join(MCP_DIR, 'fixtures', 'web-eval.json'));
    const fetcher = mode === 'live' ? globalThis.fetch : buildReplayFetcher(fixtures.responses).fetcher;
    const result = await runEval({ fixtures, ctx: { cfg, cache, fetcher }, mode });
    const payload = { ...result };
    if (gate) payload.gate = evalGate(result, thresholds || {});
    return payload;
  }

  async feeds(input = {}) {
    const search = await this.engine();
    const feeds = search.feeds;
    if (input.action === 'add') {
      if (!input.url) throw new Error('add wymaga url');
      const added = await feeds.addFeed(input.url, { intent: input.intent, name: input.name });
      await search.cache.flushAll();
      return { ok: true, added, feeds: await feeds.listFeeds() };
    }
    if (input.action === 'remove') {
      if (!input.url) throw new Error('remove wymaga url');
      await feeds.removeFeed(input.url);
      await search.cache.flushAll();
      return { ok: true, removed: true, feeds: await feeds.listFeeds() };
    }
    if (input.action === 'reindex') {
      const summary = await feeds.reindex({ force: true });
      await search.cache.flushAll();
      return { ok: true, reindex: summary, snapshot: feeds.snapshot() };
    }
    return { ok: true, feeds: await feeds.listFeeds(), snapshot: feeds.snapshot() };
  }

  async configure() {
    return { ok: true, config: this.cfg, renderer: this.renderer ? 'obscura (leniwy)' : 'brak' };
  }

  async close() {
    if (this.renderer && typeof this.renderer.close === 'function') await this.renderer.close();
  }
}
