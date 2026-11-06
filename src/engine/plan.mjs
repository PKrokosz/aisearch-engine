/**
 * web/plan.mjs — AiSearch etap 1: dekompozycja zapytania na intencje.
 *
 * FUNKCJA CZYSTA (zero sieci, zero LLM). Jedyne miejsce, które wie, że
 * „changelog PHP 8.4" to dwie intencje o różnej wadze: official-docs + changelog.
 * Każdy inny etap bierze to jako gotowy plan i nie musi interpretować języka.
 */

import { INTENT_TYPES, STALENESS_MS, SOURCE_FAMILIES } from './types.mjs';

/** Słowa kluczowe per intencja. Dłuższe frazy ważą więcej niż krótkie. */
export const INTENT_KEYWORDS = {
  advisory: ['cve', 'vulnerab', 'exploit', 'kev', 'advisory', 'luka', 'podatnoś', 'zabezpiecz', 'security', 'patch security'],
  changelog: ['changelog', 'release note', 'co nowego', 'zmiany', 'zmian', 'upgrade', 'migrac', 'wersj', 'wydanie', 'nowa wersja'],
  'official-docs': ['docs', 'documentation', 'reference', 'manual', 'instrukcja', 'konfigurac', 'jak ', 'how to', 'api ', 'przewodnik'],
  repo: ['github', 'repo', 'repository', 'source code', 'kod źródłowy', 'biblioteka', 'package', 'npm', 'packagist', 'composer'],
  discussion: ['stackoverflow', 'forum', 'dyskusj', 'stack overflow', 'rozwiąz', 'problem', 'błąd', 'error', 'nie działa', 'crash'],
  news: ['news', 'aktualn', 'co słychać', 'teraz', 'dzisiaj', 'wczoraj', 'ogłosz', 'hype'],
  reference: ['wikipedia', 'definicja', 'co to jest', 'encyklopedia', 'termin'],
  'local-pl': ['polski blog', 'blog pl', 'krokosz', 'pkrokosz', 'po polsku', 'pl '],
};

/** Intencje wymagające świeżości danych. */
const FRESH_INTENTS = new Set(['news', 'advisory']);
/** Intencje, które akceptują też trochę starsze źródła. */
const RECENT_INTENTS = new Set(['changelog']);

const MAX_INTENTS = 3;

function scoreIntents(query) {
  const q = ` ${query.toLowerCase()} `;
  const scores = new Map();
  for (const [intent, keys] of Object.entries(INTENT_KEYWORDS)) {
    let total = 0;
    for (const key of keys) {
      if (q.includes(key)) total += key.length; // dłuższa fraza = silniejszy sygnał
    }
    if (total > 0) scores.set(intent, total);
  }
  return scores;
}

/**
 * Zaplanuj wyszukiwanie.
 * @returns {object} plan — gotowy kontrakt dla propose/resolve/falsify
 */
export function planQuery(spec = {}, cfg = {}) {
  const query = String(spec.query || '').trim();
  const scores = scoreIntents(query);
  let intents = [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([i]) => i)
    .filter((i) => INTENT_TYPES.includes(i))
    .slice(0, MAX_INTENTS);

  const requested = Array.isArray(spec.intents) ? spec.intents.filter((i) => INTENT_TYPES.includes(i)) : [];
  if (requested.length) intents = [...new Set([...requested, ...intents])].slice(0, MAX_INTENTS);
  if (!intents.length) intents = ['official-docs', 'reference'];

  const total = [...scores.values()].reduce((a, b) => a + b, 0) || 1;
  const weights = {};
  for (const i of intents) weights[i] = Number(((scores.get(i) || 0) / total || 1 / intents.length).toFixed(3));
  const wsum = Object.values(weights).reduce((a, b) => a + b, 0) || 1;
  for (const i of intents) weights[i] = Number((weights[i] / wsum).toFixed(3));

  const staleness = spec.staleness || (intents.some((i) => FRESH_INTENTS.has(i)) ? 'fresh' : intents.some((i) => RECENT_INTENTS.has(i)) ? 'recent' : 'any');

  const perIntent = Math.max(3, Math.ceil((spec.limit || 10) / intents.length) + 2);

  return {
    query,
    intents,
    weights,
    staleness,
    stalenessMs: STALENESS_MS[staleness] ?? 0,
    sourceFamilies: Object.fromEntries(intents.map((i) => [i, SOURCE_FAMILIES[i] || []])),
    budget: {
      maxRequests: cfg.maxRequests ?? 24,
      concurrency: cfg.concurrency ?? 6,
      timeoutMs: cfg.timeoutMs ?? 10000,
      maxCandidatesPerIntent: perIntent,
    },
    thresholds: {
      minScore: Number(spec.minScore ?? cfg.minScore ?? 0.25),
      coverage: Number(spec.coverageThreshold ?? cfg.coverageThreshold ?? 0.35),
    },
  };
}

/** Podsumowanie planu w języku naturalnym (dla dashboardu i logów). */
export function describePlan(plan) {
  const parts = plan.intents.map((i) => `${i} ${Math.round((plan.weights[i] || 0) * 100)}%`);
  return `${plan.intents.length} intencje (${parts.join(', ')}), swieżość: ${plan.staleness}`;
}
