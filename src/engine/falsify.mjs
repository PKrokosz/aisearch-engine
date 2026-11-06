/**
 * web/falsify.mjs — AiSearch etap 4: werdykt o kandydacie.
 *
 * FUNKCJA CZYSTA (zero sieci). Bierze to, co resolve wydobył z JEDNEGO
 * requestu (tytuł, tekst, datę, latency), i decyduje: czy to odpowiedź,
 * czy „rozwiązał się 200, ale jest off-topic" — najgroźniejszy tryb awarii.
 *
 * Scoring: title 0.55 | content 0.20 | freshness 0.15 | speed 0.10
 * „Brak wyniku" jest poprawną odpowiedzią — zero wyników przechodzi dalej
 * jako prawda, nie jako awaria.
 */

import { SCORE_WEIGHTS, STALENESS_MS } from './types.mjs';

export const STOPWORDS = new Set([
  // en
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'is', 'are', 'how', 'do', 'i', 'my', 'it', 'that', 'this', 'what', 'which',
  // pl
  'i', 'w', 'na', 'z', 'do', 'jak', 'co', 'to', 'sie', 'się', 'jest', 'dla', 'po', 'od', 'the', 'that', 'mie', 'mnie', 'czy', 'a', 'o', 'że', 'ze',
]);

/** Tokenizacja zapytania — wspólna dla scoringu i parsowania HTML. */
export function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9ąćęłńóśźżĄĆĘŁŃÓŚŹŻ.]+/)
    .map((t) => t.replace(/^\.+|\.+$/g, ''))
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/** HTML → tekst widoczny. Bez zależności npm, bo moduł musi być lekki. */
export function htmlToText(html, maxLen = 4000) {
  return String(html || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

/** Metadane z HTML — wykonywane na treści JEDNEGO requestu, zero dodatkowych zapytań. */
export function extractMeta(html, baseUrl = '') {
  const src = String(html || '');
  const pick = (re) => {
    const m = src.match(re);
    return m ? m[1].trim().slice(0, 400) : null;
  };
  const title =
    pick(/<title[^>]*>([\s\S]{1,300}?)<\/title>/i) ||
    pick(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']{1,300})["']/i) ||
    null;
  const description =
    pick(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']{1,400})["']/i) ||
    pick(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']{1,400})["']/i) ||
    null;
  const canonical = pick(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']{1,400})["']/i);
  const publishedAt =
    pick(/<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']{1,40})["']/i) ||
    pick(/<meta[^>]+name=["'](?:date|pubdate|publish-date)["'][^>]+content=["']([^"']{1,40})["']/i) ||
    pick(/<time[^>]+datetime=["']([^"']{1,40})["']/i);
  return {
    title,
    description,
    canonical,
    publishedAt,
    publishedMs: publishedAt ? Date.parse(publishedAt) : null,
    fetchedAt: Date.now(),
  };
}

/** Świeżość 0..1. Nieznana data = 0.5 (neutralnie), nie 0 — inaczej karamy dokumentację bez daty. */
export function freshnessScore(publishedMs, staleness = 'any') {
  if (!publishedMs || !Number.isFinite(publishedMs)) return 0.5;
  const window = STALENESS_MS[staleness] ?? 0;
  if (!window) return 0.75;
  const age = Date.now() - publishedMs;
  if (age <= window) return 1;
  if (age >= window * 8) return 0;
  return Number((1 - (age - window) / (window * 7)).toFixed(4));
}

/** Prędkość 0..1 z latency requestu. */
export function speedScore(latencyMs = 0) {
  if (latencyMs <= 300) return 1;
  if (latencyMs >= 2000) return 0;
  return Number((1 - (latencyMs - 300) / 1700).toFixed(4));
}

function overlap(queryTokens, tokens) {
  if (!queryTokens.length || !tokens.length) return 0;
  const set = new Set(tokens);
  let hit = 0;
  for (const t of queryTokens) if (set.has(t)) hit += 1;
  return hit / queryTokens.length;
}

/**
 * Werdykt o jednym kandydacie.
 * @returns {{score:number, signals:object, ok:boolean}}
 */
export function scoreCandidate(candidate, { minScore = 0.25 } = {}) {
  const queryTokens = tokenize(candidate.query);
  const titleTokens = tokenize(candidate.title);
  const bodyTokens = tokenize(candidate.text);

  const signals = {
    titleMatch: Number(overlap(queryTokens, titleTokens).toFixed(4)),
    contentMatch: Number(overlap(queryTokens, bodyTokens).toFixed(4)),
    freshness: freshnessScore(candidate.publishedMs, candidate.staleness),
    speed: speedScore(candidate.latencyMs),
  };

  const score = Number(
    (
      SCORE_WEIGHTS.title * signals.titleMatch +
      SCORE_WEIGHTS.content * signals.contentMatch +
      SCORE_WEIGHTS.freshness * signals.freshness +
      SCORE_WEIGHTS.speed * signals.speed
    ).toFixed(4)
  );

  return { score, signals, ok: score >= minScore };
}

/**
 * Pokrycie = czy w ogóle mamy wystarczająco dobre wyniki, czy trzeba uciekać
 * do SERP. Średnia z top-3. Zero wyników = coverage 0 = jawne „brak".
 */
export function coverageOf(results, { coverage: threshold = 0.35 } = {}) {
  if (!results.length) return { score: 0, needFallback: true, reason: 'brak zweryfikowanych wyników' };
  const top = results.slice(0, 3).map((r) => r.score);
  const score = Number((top.reduce((a, b) => a + b, 0) / top.length).toFixed(4));
  return {
    score,
    needFallback: score < threshold,
    reason: score < threshold ? `coverage ${score} < prog ${threshold}` : null,
  };
}
