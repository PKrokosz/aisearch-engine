#!/usr/bin/env node
/**
 * mcp/server.mjs — zunifikowany serwer MCP: JEDEN proces, JEDEN protokół.
 *
 * Synteza dwóch światów w jednym serwerze stdio:
 *   web.*     — silnik AiSearch (mózg: plan → resolve → falsify → learn)
 *   browser_* — przeglądarka Obscura (ręce: V8, interakcje, screenshot/PDF)
 *
 * Zero zależności runtime: protokół JSON-RPC 2.0 po liniach (NDJSON) jest
 * napisany ręcznie — SDK MCP byłoby więcej szumu niż wartości dla 4 metod.
 *
 * Renderer jest leniwy: czyste web.* nie startuje przeglądarki; startuje ją
 * pierwszy render (auto/przeglądarka) lub pierwsze wywołanie browser_*.
 */
import { createInterface } from 'node:readline';

import { AiSearchInstance } from '../engine/instance.mjs';
import { BrowserUnavailableError } from '../browser/client.mjs';

const SERVER_INFO = { name: 'aisearch', version: '1.0.0' };

const LOCAL_TOOLS = [
  {
    name: 'web.search',
    description:
      'AiSearch: szukaj w zamkniętym ekosystemie (plan → propose → resolve → falsify → [SERP] → learn). Model zgaduje adresy, HTTP je weryfikuje i naprawia (redirect/Wayback). JS-shelle renderuje przeglądarka (auto), gdy treść < renderMinText. Wynik: ranked + provenance + ślad decyzji.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'zapytanie (PL lub EN)' },
        urls: { type: 'array', items: { type: 'string' }, description: 'własne kandydaci URL (proposer inline, 0 kosztów)' },
        intents: { type: 'array', items: { type: 'string' }, description: 'wymuś intencje, np. ["advisory"]' },
        staleness: { type: 'string', enum: ['fresh', 'recent', 'any'] },
        limit: { type: 'number', description: 'docelowa liczba wyników (1-50)' },
        serp: { type: 'boolean', description: 'wymuś/wyłącz escape hatch do SERP' },
        render: { type: 'string', enum: ['off', 'auto', 'all'], description: 'polityka renderowania (domyślnie auto gdy przeglądarka dostępna)' },
        top: { type: 'number', description: 'ile najlepszych zwrócić (domyślnie 5)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'web.brief',
    description: 'Jedno wywołanie → zwinięty brief: ranking + provenance (repaired/rendered/fromCache) + coverage + uwagi. Do raportów, nie do debugu.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' }, urls: { type: 'array', items: { type: 'string' } }, top: { type: 'number' } },
      required: ['query'],
    },
  },
  {
    name: 'web.verify_links',
    description: 'Partia kandydatów w JEDNYM wywołaniu: survived / rejected / repaired (dowód sensu auto-korektora). serp domyślnie wyłączony — tu celowo bez wynalazców.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' }, urls: { type: 'array', items: { type: 'string' } }, top: { type: 'number' }, serp: { type: 'boolean' } },
      required: ['urls'],
    },
  },
  {
    name: 'web.drift_report',
    description: 'Raport driftu dokumentacji + prior źródeł + werdykt w języku naturalnym. Domeny, które zaczęły przekierowywać = docs się przestawiły.',
    inputSchema: { type: 'object', properties: { threshold: { type: 'number', description: 'próg redirect_ratio (domyślnie 0.25)' } } },
  },
  {
    name: 'web.render',
    description: 'Render jednej strony przez przeglądarkę (V8): JS, SPA, treść za interakcją. Zwraca markdown + tytuł. Drogie — używaj świadomie.',
    inputSchema: { type: 'object', properties: { url: { type: 'string' }, timeoutMs: { type: 'number' } }, required: ['url'] },
  },
  {
    name: 'web.trace',
    description: 'Pełny ślad etapów w języku naturalnym (to, co dashboard rysuje) + statystyki. Do debugowania „co się zadziało".',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, urls: { type: 'array', items: { type: 'string' } }, top: { type: 'number' } }, required: ['query'] },
  },
  {
    name: 'web.feedback',
    description: 'Pętla użyteczności: used/opened/ignored/rejected → linklog → prior. Bez tego system uczy się rozstrzygać linki, a nie pomagać.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string' }, label: { type: 'string', enum: ['used', 'opened', 'ignored', 'rejected'] }, query: { type: 'string' } },
      required: ['url', 'label'],
    },
  },
  { name: 'web.eval', description: 'Ewaluacja jakości (replay offline / live) + opcjonalnie werdykt bramki regresji.', inputSchema: { type: 'object', properties: { mode: { type: 'string', enum: ['replay', 'live'] }, gate: { type: 'boolean' }, thresholds: { type: 'object' } } } },
  { name: 'web.stats', description: 'Wnętrze ekosystemu: cache, prior, drift, liczba wyszukań w sesji.', inputSchema: { type: 'object', properties: {} } },
  { name: 'web.drift', description: 'Detektor driftu: domeny z przyspieszonymi przekieraniami.', inputSchema: { type: 'object', properties: { threshold: { type: 'number' } } } },
  { name: 'web.cache', description: 'Stan lub czyszczenie cache (resolve/content/feeds).', inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['stats', 'clear'] } } } },
  { name: 'web.feeds', description: 'Rejestr kanałów RSS/Atom (warstwa świeżości): list/add/remove/reindex.', inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['list', 'add', 'remove', 'reindex'] }, url: { type: 'string' }, intent: { type: 'string' }, name: { type: 'string' } } } },
  { name: 'web.configure', description: 'Rozstrzygnięta konfiguracja + stan renderera.', inputSchema: { type: 'object', properties: {} } },
];

const HANDLERS = {
  'web.search': (engine, a) => engine.search(a),
  'web.brief': (engine, a) => engine.brief(a),
  'web.verify_links': (engine, a) => engine.verifyLinks(a),
  'web.drift_report': (engine, a) => engine.driftReport(a),
  'web.render': (engine, a) => engine.render(a),
  'web.trace': (engine, a) => engine.trace(a),
  'web.feedback': (engine, a) => engine.feedback(a),
  'web.eval': (engine, a) => engine.eval(a),
  'web.stats': (engine) => engine.stats(),
  'web.drift': (engine, a) => engine.drift(a),
  'web.cache': (engine, a) => engine.cache(a),
  'web.feeds': (engine, a) => engine.feeds(a),
  'web.configure': (engine) => engine.configure(),
};

const engine = AiSearchInstance.withOptionalRenderer();

function toolText(obj, isError = false) {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }], ...(isError ? { isError: true } : {}) };
}

async function handleCall(name, args) {
  const local = HANDLERS[name];
  if (local) return toolText(await local(engine, args || {}));
  if (name.startsWith('browser_')) {
    try {
      const out = await engine.renderer.client.call(name, args || {});
      return toolText(out.data ?? { text: out.text }, out.isError);
    } catch (err) {
      const msg = err instanceof BrowserUnavailableError ? err.message : `przeglądarka niedostępna: ${String(err?.message || err)}`;
      return toolText({ ok: false, error: msg }, true);
    }
  }
  return toolText({ ok: false, error: `nieznane narzędzie: ${name}` }, true);
}

async function listTools() {
  let browser = [];
  if (engine.renderer) {
    try {
      const names = await engine.renderer.client.listTools();
      browser = names.map((n) => ({ name: n, description: `Przeglądarka Obscura (passthrough): ${n}` }));
    } catch {
      browser = []; // brak binarii — serwer i tak działa, tylko web.*
    }
  }
  return [...LOCAL_TOOLS, ...browser];
}

const rl = createInterface({ input: process.stdin });
const pending = new Map();

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

rl.on('line', async (line) => {
  line = line.trim();
  if (!line) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = msg;

  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: SERVER_INFO } });
    return;
  }
  if (method === 'notifications/initialized' || method === 'initialized') return;
  if (method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} });
    return;
  }
  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: await listTools() } });
    return;
  }
  if (method === 'tools/call') {
    try {
      const result = await handleCall(params?.name, params?.arguments);
      send({ jsonrpc: '2.0', id, result });
    } catch (err) {
      const msgText = err instanceof BrowserUnavailableError ? err.message : String(err?.message || err).slice(0, 400);
      send({ jsonrpc: '2.0', id, result: toolText({ ok: false, error: msgText }, true) });
    }
    return;
  }
  if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
  }
});

async function shutdown() {
  await engine.close().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
