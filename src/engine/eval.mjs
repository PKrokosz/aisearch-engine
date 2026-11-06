/**
 * web/eval.mjs — AiSearch: EWALUACJA (dwie rozdzielne sprawy — obie tutaj).
 *
 * A. Jakość samego szukania: hit_rate, repair_rate, false_positive,
 *    hallucination_block, precision@3, requests_per_query.
 * B. Użyteczność dla człowieka: osobne narzędzie (web.feedback), NIE ta metryka.
 *    Ewaluator mierzy ROZROZSTRZYGNIĘCIE, nie pomysłność — i to jest szczerze
 *    zapisane w wynikach, żeby nie mylić „system rozwiązuje linki" z „system pomaga".
 *
 * TRYBY:
 *   replay — nagrania z żywej sondy, deterministycznie, bez sieci → ZWROT DO CI.
 *   live   — prawdziwa sieć (pipeline z serp fallbackiem).
 *
 * Kontrola przyszłościowa: korpus zawiera też zapytania, gdzie POPRAWNĄ
 * odpowiedzią jest ZERO wyników (model zgaduje, sieve odrzuca). Bez tego
 * ewaluator nagradzałby wymyślanie.
 */

import { readFile } from 'node:fs/promises';
import { planQuery, describePlan } from './plan.mjs';
import { proposeCandidates } from './propose.mjs';
import { resolveCandidates } from './resolve.mjs';
import { scoreCandidate, coverageOf } from './falsify.mjs';
import { serpSearch } from './serp.mjs';
import { normalizeUrlKey, domainOf, pathShapeOf } from './types.mjs';

/** Załaduj korpus z pliku fixture'ów. */
export async function loadFixtures(file) {
  const txt = await readFile(file, 'utf8');
  const parsed = JSON.parse(txt);
  return { corpus: parsed.corpus || [], responses: parsed.responses || {}, meta: { recordedAt: parsed.recordedAt, note: parsed.note } };
}

/**
 * Fetcher odtwarzający nagrania: odpowiedzi trzymają POLA SEMANTYCZNE
 * (status, location, tytuł, opis, data) i sklecają minimalne HTML.
 * Pipeline wyciąga z niego metadane dokładnie jak z prawdziwego dokumentu —
 * więc metryki mają tę samą semantykę co w trybie live.
 */
export function buildReplayFetcher(responses, { missStatus = 404 } = {}) {
  const calls = [];
  const fetcher = async (url, opts = {}) => {
    calls.push({ url, redirect: opts.redirect });
    const rec = responses[url];
    if (!rec) {
      return { status: missStatus, headers: { get: () => null }, text: async () => '<html><title>brak w nagraniu</title></html>', json: async () => ({}) };
    }
    if (rec.status >= 300 && rec.status < 400 && rec.location) {
      return { status: rec.status, headers: { get: (h) => (h.toLowerCase() === 'location' ? rec.location : null) }, text: async () => '', json: async () => ({}) };
    }
    const html = [
      '<html><head>',
      rec.title ? `<title>${rec.title}</title>` : '<title></title>',
      rec.description ? `<meta name="description" content="${rec.description.replace(/"/g, '&quot;')}">` : '',
      rec.publishedAt ? `<meta property="article:published_time" content="${rec.publishedAt}">` : '',
      '</head><body>',
      rec.bodyText ? `<p>${rec.bodyText}</p>` : '',
      '</body></html>',
    ].join('');
    return {
      status: rec.status ?? 200,
      headers: { get: () => null },
      text: async () => html,
      json: async () => (rec.json ?? {}),
    };
  };
  return { fetcher, calls };
}

function matchesExpect(result, expect) {
  if (!expect) return true;
  const domain = domainOf(result.canonical || result.url);
  const shape = pathShapeOf(result.canonical || result.url);
  if (Array.isArray(expect.domains) && expect.domains.length) {
    if (expect.domains.some((d) => d === domain || domain.endsWith(`.${d}`) || d.endsWith(`.${domain}`))) return true;
  }
  if (Array.isArray(expect.pathShapes) && expect.pathShapes.length) {
    if (expect.pathShapes.some((p) => p === shape)) return true;
  }
  return false;
}

/** Uruchom pojedyncze zapytanie korpusu i zwróć miarę per-query. */
async function runOne(entry, ctx, { mode, onEvent }) {
  const plan = planQuery({ query: entry.query, ...(entry.plan || {}) }, ctx.cfg);
  const inlineUrls = mode === 'replay' ? entry.inlineUrls || [] : entry.inlineUrls || [];

  const { candidates, sources, notes } = await proposeCandidates({
    plan,
    ctx: { ...ctx, inlineUrls },
  });
  const resolved = await resolveCandidates(candidates, { cfg: ctx.cfg, cache: ctx.cache, fetcher: ctx.fetcher, onEvent });

  const verified = resolved.filter((r) => r.ok && r.httpStatus === 200);
  const rejected = resolved.filter((r) => !r.ok || r.httpStatus !== 200);
  const repaired = verified.filter((r) => r.redirects > 0 || r.archived);

  const scored = verified
    .map((r) => ({
      ...r,
      ...scoreCandidate(
        {
          query: plan.query,
          intent: r.intent,
          title: r.title || '',
          text: r.text || r.serpTitle || '',
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

  let serpUsed = false;
  let finalResults = kept;
  if (coverage.needFallback && ctx.cfg.serpEnabled && mode === 'live') {
    serpUsed = true;
    const { candidates: serpCands } = await serpSearch(plan.query, { cfg: ctx.cfg, fetcher: ctx.fetcher, planIntents: plan.intents });
    if (serpCands.length) {
      const serpResolved = await resolveCandidates(serpCands, { cfg: ctx.cfg, cache: ctx.cache, fetcher: ctx.fetcher });
      const serpScored = serpResolved
        .filter((r) => r.ok)
        .map((r) => ({ ...r, ...scoreCandidate({ query: plan.query, intent: r.intent, title: r.serpTitle || r.title || '', text: r.text || '', publishedMs: r.publishedMs, latencyMs: r.latencyMs || 0, staleness: plan.staleness }, { minScore: plan.thresholds.minScore }) }))
        .sort((a, b) => b.score - a.score);
      finalResults = [...kept, ...serpScored].sort((a, b) => b.score - a.score);
    }
  }

  const expectEmpty = entry.expectEmpty === true;
  const matched = finalResults.filter((r) => matchesExpect(r, entry.expect));
  const falsePositive = expectEmpty
    ? finalResults.length > 0
      ? 1
      : 0
    : finalResults.length > 0 && matched.length === 0
      ? 1
      : 0;

  return {
    query: entry.query,
    describePlan: describePlan(plan),
    candidates: candidates.length,
    sources,
    notes: notes || [],
    verified: verified.length,
    rejected: rejected.length,
    repaired: repaired.length,
    kept: finalResults.length,
    coverage: coverage.score,
    serpUsed,
    expectEmpty,
    matched: matched.length,
    falsePositive,
    top3: finalResults.slice(0, 3).map((r) => ({
      url: r.canonical || r.url,
      score: r.score,
      by: r.proposedBy,
      repaired: (r.redirects || 0) > 0 || r.archived === true,
    })),
    latencyP50: percentile(
      verified.map((r) => r.latencyMs || 0),
      50
    ),
  };
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

/**
 * Uruchom cały korpus.
 * @returns {{mode:string, rows:Array, totals:object}}
 */
export async function runEval({ fixtures, ctx, mode = 'replay', onEvent } = {}) {
  const rows = [];
  for (const entry of fixtures.corpus) {
    const row = await runOne(entry, ctx, { mode, onEvent });
    rows.push(row);
  }

  const sum = (key) => rows.reduce((a, r) => a + (r[key] || 0), 0);
  const candidates = sum('candidates') || 1;
  const verified = sum('verified') || 1;
  const kept = sum('kept');
  const emptyCorrect = rows.filter((r) => (r.expectEmpty ? r.kept === 0 : r.matched > 0)).length;
  const precisionAt3 = rows.reduce((a, r) => {
    if (r.expectEmpty) return a + (r.kept === 0 ? 1 : 0);
    const top3 = r.top3.length || 1;
    return a + Math.min(r.matched, top3) / top3;
  }, 0);

  const totals = {
    queries: rows.length,
    hitRate: Number((sum('verified') / candidates).toFixed(3)),
    repairRate: Number((sum('repaired') / verified).toFixed(3)),
    hallucinationBlockRate: Number((sum('rejected') / candidates).toFixed(3)),
    falsePositiveRate: Number((sum('falsePositive') / (kept || 1)).toFixed(3)),
    precisionAt3: Number((precisionAt3 / rows.length).toFixed(3)),
    emptyCorrectRate: Number((emptyCorrect / rows.length).toFixed(3)),
    expectationsMet: Number((emptyCorrect / rows.length).toFixed(3)),
    fallbackRate: Number((rows.filter((r) => r.serpUsed).length / rows.length).toFixed(3)),
    avgResultsPerQuery: Number((kept / rows.length).toFixed(2)),
  };

  return { mode, rows, totals, fixturesMeta: fixtures.meta };
}

/**
 * Bramka regresji — używana przez CI (site-gate).
 * Zwraca {pass, failures[]} progu po progu, zamiast jednego „zielonego" boola.
 */
export function evalGate(result, thresholds = {}) {
  const t = {
    minHitRate: 0.5,
    minRepairRate: 0.1,
    maxFalsePositiveRate: 0.15,
    minExpectationsMet: 0.85,
    ...thresholds,
  };
  const failures = [];
  const T = result.totals;
  if (T.hitRate < t.minHitRate) failures.push(`hit_rate ${T.hitRate} < ${t.minHitRate}`);
  if (T.repairRate < t.minRepairRate) failures.push(`repair_rate ${T.repairRate} < ${t.minRepairRate}`);
  if (T.falsePositiveRate > t.maxFalsePositiveRate) failures.push(`false_positive_rate ${T.falsePositiveRate} > ${t.maxFalsePositiveRate}`);
  if (T.expectationsMet < t.minExpectationsMet) failures.push(`expectations_met ${T.expectationsMet} < ${t.minExpectationsMet}`);
  return { pass: failures.length === 0, failures, thresholds: t };
}
