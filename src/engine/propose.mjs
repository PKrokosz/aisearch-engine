/**
 * web/propose.mjs — AiSearch etap 2: GENERATOR HIPOTEZ.
 *
 * To jedyne miejsce w całym ekosystemie, które może się mylić — i dlatego
 * jego outputem NIGDY nie jest „odpowiedź", tylko kandydaci do zweryfikowania.
 *
 * Cztery źródła kandydatów:
 *   inline — główny agent sam zgaduje URL-e z pamięci (domyślnie: 0 tokenów,
 *            0 requestów, z kontekstem rozmowy, który rozstrzyga niejednoznaczność)
 *   llm    — model przez endpoint OpenAI-compat (dla zadań cyklicznych bez agenta)
 *   feeds  — świeże itemy z rejestru kanałów RSS/Atom (warstwa świeżości)
 *   prior  — NIE wymyśla URL-i. Daje listę domen, które historycznie działały
 *            dla tej intencji → trafia jako wskazówka do generacji, nie jako kandydat.
 *
 * Uwaga projektowa: prior celowo nie produkuje URL-i. Uczenie się „który dokładny
 * URL żył" to gnijący w tygodnie sygnał, a pętla ucząca się z własnych zgadywań
 * byłaby okrężnym filtrem na własnym rozkładzie.
 */

import { normalizeUrlKey, domainOf, INTENT_TYPES } from './types.mjs';

function emit(onEvent, event) {
  if (typeof onEvent === 'function') {
    try {
      onEvent(event);
    } catch {
      /* obserwator nigdy nie wysypuje pipeline'u */
    }
  }
}

/** Dedykacja kandydatów po znormalizowanym kluczu. */
export function dedupeCandidates(candidates) {
  const seen = new Map();
  for (const c of candidates) {
    const key = normalizeUrlKey(c.url);
    if (!key || !key.startsWith('http')) continue;
    const prev = seen.get(key);
    if (!prev || (c.confidence ?? 0) > (prev.confidence ?? 0)) seen.set(key, { ...c, url: c.url.trim() });
  }
  return [...seen.values()];
}

/** Kandydaci z agenta (inline) — żadnej sieci, żadnych tokenów. */
export function proposeInline(urls = [], plan) {
  const q = plan.query.toLowerCase();
  return urls
    .map((u) => String(u || '').trim())
    .filter((u) => /^https?:\/\//.test(u))
    .map((url) => ({
      url,
      intent: guessIntentForDomain(domainOf(url), plan.intents) || plan.intents[0] || 'official-docs',
      proposedBy: 'inline',
      confidence: 0.7,
      reason: `zgadnięcie agenta dla: ${q.slice(0, 80)}`,
    }));
}

/** Wskazówki domenowe z priora — do prompta, nie do kandydatów. */
export function domainsFromPrior(prior = [], intents = [], limit = 6) {
  const wanted = new Set(intents);
  return prior
    .filter(
      (s) =>
        s.n >= 3 && // za mało prób = brak wnioskowania
        (wanted.has(s.intent) || s.intent === 'any') &&
        s.successRate >= 0.5 && // próg jakości: dryfująca/martwa domena nie jest wskazywana
        s.redirectRatio < 0.5 // i nie wartuje sugerować źródła w trakcie przebudowy docs
    )
    .sort((a, b) => b.successRate * 0.6 + b.utilityRate * 0.4 - (a.successRate * 0.6 + a.utilityRate * 0.4))
    .slice(0, limit)
    .map((s) => s.domain);
}

/** Kandydaci z feedindex — jedyna warstwa, która naturalnie niesie świeżość. */
export function proposeFromFeeds(feedIndex, plan, perIntentLimit) {
  if (!feedIndex || typeof feedIndex.match !== 'function') return [];
  const out = [];
  for (const intent of plan.intents) {
    const items = feedIndex.match({ query: plan.query, intent, limit: perIntentLimit });
    for (const item of items) {
      out.push({
        url: item.link,
        intent: item.intent || intent,
        proposedBy: 'feeds',
        confidence: 0.8,
        reason: `kanał ${item.feed || ''} — ${item.title || ''}`.slice(0, 160),
        feedTitle: item.title || null,
        publishedAt: item.publishedAt || null,
        publishedMs: item.publishedMs || null,
      });
    }
  }
  return out;
}

/** Propozycja przez LLM — z kontraktem, który zabrania udawania wyszukiwarki. */
export async function proposeFromLlm(plan, { url, key, model, fetcher = globalThis.fetch, timeoutMs = 20000, domainHints = [] }) {
  if (!url || !model) return { candidates: [], note: 'llm proposer nie skonfigurowany (WEB_LLM_URL/WEB_LLM_MODEL)' };
  const system = [
    'Jesteś GENERATOREM HIPOTEZ URL-ów, nie wyszukiwarką.',
    'Nie masz indeksu internetu. Twoja rola: zgadnąć adresy, które POWINIEN istnieć.',
    'ZASADY:',
    '- nigdy nie twierdź, że URL jest zweryfikowany — weryfikuje go pipeline,',
    '- jeśli nie masz pewności, zwróć mniej URL-ów albo pustą tablicę — puste [] jest POPRAWNĄ odpowiedzią,',
    '- wolno Ci proponować tylko http(s) URL-e, nie ścieżki względne,',
    '- każdemu URL nadaj intent z listy i confidence 0..1.',
  ].join('\n');

  const user = JSON.stringify({
    query: plan.query,
    intents: plan.intents,
    weights: plan.weights,
    source_families: Object.fromEntries(Object.entries(plan.sourceFamilies || {}).map(([k, v]) => [k, v.slice(0, 8)])),
    domains_that_worked_before: domainHints,
    max: plan.budget.maxCandidatesPerIntent * plan.intents.length,
  });

  try {
    const res = await fetcher(`${url}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        max_tokens: 700,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: `${user}\n\nZwróć WYŁĄCZNIE tablicę JSON: [{"url","intent","confidence","reason"}]` },
        ],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content || '';
    const candidates = parseLlmCandidates(text, plan);
    return { candidates, note: candidates.length ? null : `llm zwrócił 0 kandydatów (raw: ${text.slice(0, 120)})` };
  } catch (err) {
    return { candidates: [], note: `llm proposer padł: ${String(err?.message || err).slice(0, 120)}` };
  }
}

/** Tolerancyjny parser odpowiedzi LLM — wycina tablicę JSON z dowolnego otoczenia. */
export function parseLlmCandidates(text, plan) {
  const raw = String(text || '');
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((c) => c && typeof c.url === 'string' && /^https?:\/\//.test(c.url))
    .map((c) => ({
      url: c.url.trim().slice(0, 500),
      intent: INTENT_TYPES.includes(c.intent) ? c.intent : plan.intents[0],
      proposedBy: 'llm',
      confidence: Math.max(0, Math.min(1, Number(c.confidence) || 0.5)),
      reason: String(c.reason || 'hipoteza llm').slice(0, 160),
    }));
}

/** Wybór intencji dla domeny z inline guess — prosta heurystyka, bez sieci. */
export function guessIntentForDomain(domain, intents = []) {
  if (!domain) return null;
  if (domain.includes('github.com') || domain.includes('gitlab.com')) {
    return intents.includes('repo') ? 'repo' : intents.includes('changelog') ? 'changelog' : 'repo';
  }
  if (domain.includes('wikipedia.org')) return 'reference';
  if (domain.includes('stackoverflow.com') || domain.includes('reddit.com')) return 'discussion';
  if (domain.includes('nvd.nist.gov') || domain.includes('cisa.gov') || domain.includes('advisories')) return 'advisory';
  return null;
}

/**
 * Główny punkt wejścia etapu 2.
 * Zbieramy kandydatów ze wszystkich skonfigurowanych źródeł równolegle,
 * deduplikujemy i tniemy do budżetu per intencja.
 */
export async function proposeCandidates({ plan, ctx }) {
  const cfg = ctx.cfg;
  const perIntent = Math.max(2, plan.budget.maxCandidatesPerIntent || 8);
  const notes = [];
  const sources = {};

  emit(ctx.onEvent, { stage: 'propose', type: 'start', message: `źródła: ${cfg.proposers.join(', ') || 'brak'}` });

  // Równoległość: wszystkie niezależne źródła startują jednocześnie.
  // Wolny proposer (llm) nie blokuje szybkiego (inline/feeds).
  const tasks = [];
  if (cfg.proposers.includes('inline') && Array.isArray(ctx.inlineUrls) && ctx.inlineUrls.length) {
    tasks.push(Promise.resolve({ by: 'inline', candidates: proposeInline(ctx.inlineUrls, plan) }));
  }
  if (cfg.proposers.includes('feeds') && ctx.feedIndex) {
    tasks.push(Promise.resolve({ by: 'feeds', candidates: proposeFromFeeds(ctx.feedIndex, plan, perIntent) }));
  }
  if (cfg.proposers.includes('llm')) {
    const hints = domainsFromPrior(ctx.prior || [], plan.intents);
    tasks.push(
      proposeFromLlm(plan, { ...cfg.llm, domainHints: hints }).then((r) => {
        if (r.note) notes.push(r.note);
        return { by: 'llm', candidates: r.candidates };
      })
    );
  }

  const settled = await Promise.allSettled(tasks);
  const collected = [];
  for (const s of settled) {
    if (s.status === 'fulfilled') {
      sources[s.value.by] = s.value.candidates.length;
      collected.push(...s.value.candidates);
      emit(ctx.onEvent, { stage: 'propose', type: 'source', by: s.value.by, count: s.value.candidates.length, message: `${s.value.by}: ${s.value.candidates.length} kandydatów` });
    } else {
      notes.push(`źródło padło: ${String(s.reason?.message || s.reason).slice(0, 100)}`);
    }
  }

  let candidates = dedupeCandidates(collected);

  // Priorytet priora: wzmocnienie confidence kandydatów z domen, które się opłacały.
  if (ctx.priorIndex) {
    candidates = candidates.map((c) => ({
      ...c,
      priorBoost: Number(priorBoostOf(ctx.priorIndex, c).toFixed(3)),
    }));
    candidates.sort((a, b) => (b.confidence + (b.priorBoost || 0.5)) - (a.confidence + (a.priorBoost || 0.5)));
  } else {
    candidates.sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
  }

  // Budżet per intencja.
  const budgeted = [];
  const used = {};
  for (const c of candidates) {
    used[c.intent] = used[c.intent] || 0;
    if (used[c.intent] < perIntent) {
      budgeted.push(c);
      used[c.intent] += 1;
    }
  }

  emit(ctx.onEvent, {
    stage: 'propose',
    type: 'done',
    count: budgeted.length,
    sources,
    message: `koniec: ${budgeted.length} kandydatów po deduplikacji i budżecie (${Object.entries(sources).map(([k, v]) => `${k}=${v}`).join(', ') || 'brak źródeł'})`,
  });
  return { candidates: budgeted, sources, notes };
}

function priorBoostOf(index, candidate) {
  const domain = domainOf(candidate.url);
  const stat = index.get(`${domain}|${candidate.intent}`) || index.get(`${domain}|any`);
  if (!stat || stat.n < 3) return 0.5;
  return Math.max(0, Math.min(1, 0.5 + 0.35 * stat.successRate + 0.2 * stat.utilityRate - 0.25 * stat.redirectRatio));
}
