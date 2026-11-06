/**
 * web/learn.mjs — AiSearch: linklog, prior źródeł, detektor driftu.
 *
 * ZASADA (korekta pomysłu A): uczymy się ŹRÓDEŁ i ich użyteczności,
 * nigdy dokładnych URL-i. URL gnije w tygodnie (docs się przestawiają),
 * a pętla ucząca się z własnych zgadywań byłaby okrężnym filtrem high-pass
 * na własnym rozkładzie — wiecznie „MDN działa", bez odkrycia ogona.
 *
 * Z tego powodu:
 *   1. prior liczymy per (domena, intencja) na poziomie kształtu ścieżki,
 *   2. linklog karmią WSZYSCY producenci (inline, llm, feeds, serp) — nie tylko własne zgadywania,
 *   3. redirect_ratio per domena = sygnał, że docs właśnie się przestawiły.
 */

import { appendFile, readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { domainOf, pathShapeOf } from './types.mjs';

export const PRIOR_TTL_MS = 24 * 3600 * 1000;

/** Dopisz wpis do linklog.jsonl (append-only, najtańszy zapis). */
export async function appendLinkLog(logFile, entry) {
  try {
    await mkdir(dirname(logFile), { recursive: true });
    await appendFile(logFile, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** Odczytaj ostatnie N wpisów linklogu. */
export async function readLinkLog(logFile, limit = 5000) {
  try {
    const txt = await readFile(logFile, 'utf8');
    const lines = txt.split('\n').filter(Boolean);
    const out = [];
    for (const line of lines.slice(-limit)) {
      try {
        out.push(JSON.parse(line));
      } catch {
        /* pomin uszkodzoną linię */
      }
    }
    return out;
  } catch {
    return [];
  }
}

function pushStat(bucket, key, update) {
  if (!bucket.has(key)) {
    bucket.set(key, {
      key,
      domain: update.domain,
      intent: update.intent,
      n: 0,
      success: 0,
      redirects: 0,
      failed: 0,
      archived: 0,
      utilityUsed: 0,
      utilityRejected: 0,
      latencySum: 0,
      lastSeen: 0,
      proposeBy: {},
    });
  }
  const s = bucket.get(key);
  s.n += 1;
  if (update.success) s.success += 1;
  if (update.redirects > 0) s.redirects += 1;
  if (!update.success) s.failed += 1;
  if (update.archived) s.archived += 1;
  if (update.utility === 'used' || update.utility === 'opened') s.utilityUsed += 1;
  if (update.utility === 'rejected') s.utilityRejected += 1;
  s.latencySum += Number(update.latencyMs || 0);
  s.lastSeen = Math.max(s.lastSeen, Number(update.atMs || Date.now()));
  const by = String(update.proposedBy || 'unknown');
  s.proposeBy[by] = (s.proposeBy[by] || 0) + 1;
  return s;
}

function finishStat(s) {
  const n = Math.max(1, s.n);
  return {
    ...s,
    successRate: s.success / n,
    redirectRatio: s.redirects / n,
    failRate: s.failed / n,
    archivedRate: s.archived / n,
    avgLatencyMs: Math.round(s.latencySum / n),
    utilityRate: s.utilityUsed / n,
  };
}

/**
 * Z linklogu wylicz prior źródeł: per (domena, intencja).
 * Okno kroczące — tylko ostatnie `window` wpisów.
 */
export function computePrior(entries, { window = 5000 } = {}) {
  const buckets = new Map();
  for (const e of entries.slice(-window)) {
    if (!e || !e.domain) continue;
    const key = `${e.domain}|${e.intent || 'any'}`;
    pushStat(buckets, key, {
      domain: e.domain,
      intent: e.intent || 'any',
      success: e.httpStatus === 200 || e.resolved === true,
      redirects: e.redirects || 0,
      archived: e.archived === true,
      utility: e.utility,
      latencyMs: e.latencyMs,
      proposedBy: e.proposedBy,
      atMs: e.at ? Date.parse(e.at) : Date.now(),
    });
  }
  return [...buckets.values()].map(finishStat);
}

/** Krótka postać priora: mapa klucz → statystyki. */
export function priorIndex(prior) {
  const idx = new Map();
  for (const s of prior) idx.set(`${s.domain}|${s.intent}`, s);
  return idx;
}

/**
 * Wzmocnienie priorytetoze dla kandydata, 0..1:
 *   baza 0.5 (neutralny) ± doświadczenie domeny,
 *   minus kara gdy domena niedawno zaczęła przekierowywać (drift).
 */
export function priorBoost(index, url, intent) {
  const domain = String(url || '').toLowerCase().replace(/^https?:\/\//, '').split('/')[0].replace(/^www\./, '');
  if (!domain) return 0.5;
  const s = index.get(`${domain}|${intent || 'any'}`) || index.get(`${domain}|any`);
  if (!s || s.n < 3) return 0.5;
  let boost = 0.5 + 0.35 * s.successRate + 0.2 * s.utilityRate - 0.25 * s.redirectRatio;
  return Math.max(0, Math.min(1, boost));
}

/**
 * Detektor driftu: domeny, które zaczęły przekierowywać albo umierać.
 * To sygnał, którego nie kupisz w żadnym płatnym API — skok redirect_ratio
 * znaczy „docs właśnie się przestawiły", więc obniż wagę nim linki poumierają.
 */
export function detectDrift(prior, { threshold = 0.25, minSamples = 5 } = {}) {
  const flagged = [];
  for (const s of prior) {
    if (s.n < minSamples) continue;
    if (s.redirectRatio >= threshold) {
      flagged.push({
        domain: s.domain,
        intent: s.intent,
        redirectRatio: Number(s.redirectRatio.toFixed(3)),
        successRate: Number(s.successRate.toFixed(3)),
        n: s.n,
        reason: 'docs/url structure drifting — down-weight stale guesses',
      });
    }
  }
  return flagged.sort((a, b) => b.redirectRatio - a.redirectRatio);
}

/** Zapisz prior do pliku JSON (snapshot, do debugowania i testów). */
export async function writePrior(file, prior) {
  try {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ computedAt: new Date().toISOString(), prior }, null, 1), 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Zbuduj wpis linklogu ze skonsolidowanego wyniku resolve/falsify.
 * Jedno miejsce, które decyduje co trafia do nauki — żeby kształt był stały.
 */
export function linkLogEntry({
  requested,
  canonical,
  intent,
  proposedBy,
  httpStatus,
  redirects,
  archived,
  latencyMs,
  utility,
  score,
  title,
}) {
  const finalUrl = canonical || requested || '';
  return {
    requested,
    canonical: canonical || null,
    // domena i kształt ścieżki wyprowadzane TU, nie u piszącego log: prior
    // uczy się źródeł i wzorców ścieżek, nie dokładnych (gnijących) URL-i.
    domain: domainOf(finalUrl),
    pathShape: pathShapeOf(finalUrl),
    intent: intent || 'any',
    proposedBy: proposedBy || 'unknown',
    httpStatus: Number(httpStatus || 0),
    redirects: Number(redirects || 0),
    archived: Boolean(archived),
    latencyMs: Number(latencyMs || 0),
    resolved: httpStatus === 200,
    utility: utility || null,
    score: Number.isFinite(score) ? score : null,
    title: title || null,
  };
}
