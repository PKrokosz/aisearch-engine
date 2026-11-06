/**
 * web/serp.mjs — AiSearch: ESCAPE HATCH (ostatnia warstwa).
 *
 * Wywoływany TYLKO gdy własne warstwy nie dają pokrycia (coverage < próg).
 * Nigdy nie jest pierwszą opcją: to on jest najdroższy, najtrudniejszy
 * w utrzymaniu i — w przypadku Google — właściwie niemożliwy.
 *
 * Providery: ddg-html (domyślnie), bing-html, własny endpoint (searxng).
 * Wynik zawsze jest oznaczony proposedBy: 'serp', żeby pipeline wiedział,
 * że te URL-e nie są hipotezą własną i trafiają do nauki jako ŹRÓDŁO
 * zewnętrzne (to łamie okręzność uczenia się z własnych zgadywań).
 */

import { domainOf } from './types.mjs';

const ENDPOINTS = {
  'ddg-html': (q) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
  'bing-html': (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}&setlang=en`,
  'ddg-lite': (q) => `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}`,
};

/** Rozpakuj przekierowujący link DDG do prawdziwego adresu. */
function unwrapDdg(href) {
  try {
    if (/duckduckgo\.com\/l\/\?/i.test(href) || /uddg=/i.test(href)) {
      const u = new URL(href, 'https://duckduckgo.com');
      const target = u.searchParams.get('uddg');
      if (target) return decodeURIComponent(target);
    }
    return href;
  } catch {
    return href;
  }
}

/** Parsery SERP — celowo tolerancyjne: markup się zmienia, my łapiemy 0 zamiast crash. */
const PARSERS = {
  'ddg-html': (html) => {
    const out = [];
    for (const m of String(html || '').matchAll(/<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
      out.push({ url: unwrapDdg(m[1]), title: m[2].replace(/<[^>]+>/g, '').trim() });
    }
    return out;
  },
  'ddg-lite': (html) => {
    const out = [];
    for (const m of String(html || '').matchAll(/<a[^>]+href="([^"]+)"[^>]*class="[^"]*result-link[^"]*"[^>]*>([\s\S]*?)<\/a>/gi)) {
      out.push({ url: unwrapDdg(m[1]), title: m[2].replace(/<[^>]+>/g, '').trim() });
    }
    return out;
  },
  'bing-html': (html) => {
    const out = [];
    for (const m of String(html || '').matchAll(/<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
      const url = m[1];
      if (!/^https?:\/\//.test(url) || /bing\.com\/(images|videos|aclk)/i.test(url)) continue;
      out.push({ url, title: m[2].replace(/<[^>]+>/g, '').trim() });
    }
    return out;
  },
};

/**
 * Wyszukiwanie zapasowe. Zwraca kandydatów (nigdy „odpowiedzi").
 * @returns {Promise<{candidates:Array, note:string|null}>}
 */
export async function serpSearch(query, { cfg, fetcher = globalThis.fetch, limit = 6, planIntents = [] } = {}) {
  if (!cfg.serpEnabled) return { candidates: [], note: 'serp fallback wylaczony (WEB_SERP_ENABLED=false)' };
  const provider = cfg.serpProvider;
  const endpoint = cfg.serpEndpoint || ENDPOINTS[provider];
  const parser = PARSERS[provider];
  if (!endpoint || !parser) {
    return { candidates: [], note: `nieznany provider SERP: ${provider} (ddg-html | ddg-lite | bing-html)` };
  }

  try {
    const res = await fetcher(endpoint(query), {
      headers: {
        accept: 'text/html,application/xhtml+xml',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AiSearch/1.0',
        ...(cfg.serpKey ? { authorization: `Bearer ${cfg.serpKey}` } : {}),
      },
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
    if (res.status !== 200) return { candidates: [], note: `SERP ${provider} → HTTP ${res.status}` };
    const html = await res.text();
    const hits = parser(html)
      .filter((h) => /^https?:\/\//.test(h.url))
      .slice(0, limit)
      .map((h) => ({
        url: h.url,
        intent: planIntents[0] || 'official-docs',
        proposedBy: 'serp',
        confidence: 0.65,
        reason: `SERP ${provider}: ${(h.title || '').slice(0, 110)}`,
        serpTitle: h.title || null,
      }));
    return { candidates: hits, note: hits.length ? null : `SERP ${provider} zwrócił 0 trafień (markup się zmienił albo blokada)` };
  } catch (err) {
    return { candidates: [], note: `SERP ${provider} padł: ${String(err?.message || err).slice(0, 100)}` };
  }
}

/** Widoczne źródła — potrzebne dashboardowi, by pokazać skąd wyniki. */
export function serpDomainOf(url) {
  return domainOf(url);
}
