#!/usr/bin/env node
/**
 * browser/render.mjs — ESKALACJA DO PRZEGLĄDARKI (warstwa Obscury).
 *
 * Zasada syntezy: HTTP fetch zostaje na głównej ścieżce silnika (szybki,
 * liczy redirecty, deterministyczny w replay). Przeglądarka wchodzi tylko
 * tam, gdzie tekst się nie przewija:
 *
 *   resolve (fetch) → renderPass (auto: 200, ale treści < renderMinText)
 *                  → falsify (mózg werdyktuje PO renderowaniu)
 *
 * Dlaczego nie wstrzyknięcie fetchera do resolve: ręczny chód po redirectach
 * (walkRedirects) liczy hop'y, na których stoi detektor driftu — przeglądarka
 * followuje redirecty po cichu i ten licznik by zgubili. Dlatego render jest
 * OSOBNYM przebiegiem, nie zamiennikiem fetch.
 *
 * Tryby (spec.render / WEB_RENDER):
 *   'auto' — tylko gdy treść podejrzanie krótka (JS-shell) lub renderer jawny,
 *   'all'  — każdy zweryfikowany wynik (drogo, jawne),
 *   'off'  — nigdy (domyślne, gdy renderer niepodłączony).
 * Replay eval: renderERA nie ma → żadnych requestów = determinizm zachowany.
 */

/** Jeden renderer — cienka otoczka nad klientem, wystarczająca dla testów. */
export class BrowserRenderer {
  constructor({ client }) {
    this.client = client;
    this.renders = 0;
    this.errors = 0;
  }

  async renderPage(url, { timeoutMs } = {}) {
    this.renders += 1;
    return this.client.renderPage(url, { timeoutMs });
  }

  async close() {
    if (this.client && typeof this.client.close === 'function') await this.client.close();
  }
}

/**
 * Przebieg renderujący. Modyfikuje `resolved` w miejscu (text/title/rendered).
 * @param {Array} resolved wyniki resolve.mjs
 * @param {object} ctx { renderer, cfg, mode, onEvent }
 * @returns {Promise<{rendered:number, skipped:number, errors:number, budget:number}>}
 */
export async function renderPass(resolved, ctx) {
  const stats = { rendered: 0, skipped: 0, errors: 0, budget: 0 };
  const renderer = ctx.renderer;
  if (!renderer || !Array.isArray(resolved) || resolved.length === 0) return stats;

  const mode = ctx.mode || 'auto';
  if (mode === 'off') return stats;

  const cfg = ctx.cfg || {};
  const minText = Number(cfg.renderMinText ?? 200);
  const maxRenders = Math.max(0, Number(cfg.renderMax ?? 3));
  const timeoutMs = Number(cfg.renderTimeoutMs ?? 15000);
  const emit = (ev) => {
    if (typeof ctx.onEvent === 'function') {
      try {
        ctx.onEvent(ev);
      } catch {
        /* obserwator nigdy nie może wysypać pipeline'u */
      }
    }
  };

  let budget = maxRenders;
  for (const r of resolved) {
    if (!(r.ok && r.httpStatus === 200)) continue;
    const needRender = mode === 'all' || String(r.text || '').length < minText;
    if (!needRender) continue;
    if (budget <= 0) {
      stats.budget += 1;
      emit({ stage: 'render', type: 'render-budget', url: r.url, message: `budżet renderowania wyczerpany (${maxRenders})` });
      break;
    }
    budget -= 1;
    const target = r.canonical || r.url;
    try {
      const out = await renderer.renderPage(target, { timeoutMs });
      const grew = String(out.text || '').length > String(r.text || '').length;
      if (out.ok && grew) {
        r.text = out.text;
        if (!r.title && out.title) r.title = out.title;
        r.rendered = true;
        stats.rendered += 1;
        emit({ stage: 'render', type: 'rendered', url: r.url, canonical: target, textLength: out.text.length, message: `render: V8 wyciągnął ${out.text.length} znaków` });
      } else {
        stats.skipped += 1;
        emit({ stage: 'render', type: 'render-skip', url: r.url, message: 'render: przeglądarka nie dodała treści — zostaję przy fetch' });
      }
    } catch (err) {
      stats.errors += 1;
      emit({ stage: 'render', type: 'render-error', url: r.url, message: `render padł: ${String(err?.message || err).slice(0, 80)}` });
    }
  }
  return stats;
}
