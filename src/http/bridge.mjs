#!/usr/bin/env node
/**
 * http/bridge.mjs — MOST CLI: JSON na stdin → JSON na stdout (tryb = argv[1]).
 *
 * Dlaczego istnieje obok serwera HTTP: hosting dzielony bez PM2 — proces
 * jednorazowy nie potrzebuje supervisora, wyciek/crash silnika nie zabija
 * PHP-FPM i nie trzeba otwierać portu w firewallu. Koszt: cold start
 * ~400–700 ms. Za to JEDEN kod z MCP i serwerem (ten sam AiSearchInstance).
 *
 *   node src/http/bridge.mjs search  < {query, urls, top}
 *   node src/http/bridge.mjs stats
 *   node src/http/bridge.mjs eval    < {mode:"replay", gate:true}
 */
import { AiSearchInstance } from '../engine/instance.mjs';

const write = (obj) => process.stdout.write(`${JSON.stringify(obj, null, 1)}\n`);

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { __parseError: text.slice(0, 200) };
  }
}

const MODES = {
  search: (i, b) => i.search(b),
  trace: (i, b) => i.trace(b),
  brief: (i, b) => i.brief(b),
  verify_links: (i, b) => i.verifyLinks(b),
  drift_report: (i, b) => i.driftReport(b),
  render: (i, b) => i.render(b),
  feedback: (i, b) => i.feedback(b),
  stats: (i) => i.stats(),
  drift: (i) => i.drift({}),
  config: (i) => i.configure(),
  cache: (i, b) => i.cache(b),
  eval: (i, b) => i.eval(b),
  feeds: (i, b) => i.feeds(b),
};

async function main() {
  const mode = process.argv[2] || 'search';
  const input = await readStdin();
  const handler = MODES[mode];
  if (!handler) {
    write({ ok: false, error: `nieznany tryb mostka: ${mode}`, known: Object.keys(MODES) });
    process.exitCode = 2;
    return;
  }
  if (input.__parseError) {
    write({ ok: false, error: 'mostek dostał niepoprawny JSON na stdin', raw: input.__parseError });
    process.exitCode = 2;
    return;
  }
  const engine = AiSearchInstance.withOptionalRenderer();
  try {
    const out = await handler(engine, input);
    write({ ok: true, ...out });
    await engine.close();
  } catch (err) {
    write({ ok: false, error: String(err?.message || err).slice(0, 400) });
    process.exitCode = 1;
  }
}

void main();
