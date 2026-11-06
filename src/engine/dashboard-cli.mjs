/**
 * web/dashboard-cli.mjs — AiSearch w terminalu.
 *
 *   node src/index.mjs --dashboard "changelog PHP 8.4"
 *
 * Pełny ekran (TUI) gdy terminal obsługuje ANSI; w potoku/CI automatycznie
 * ten sam strumień zdarzeń jako tekst — jeden zapis, dwa widoki.
 */

import { join } from 'node:path';

import { AiSearch } from './pipeline.mjs';
import { Dashboard, searchWithDashboard } from './dashboard.mjs';
import { loadWebConfig, MCP_DIR } from './types.mjs';

const __mcpDir = MCP_DIR;

export async function startDashboard(query, opts = {}) {
  const cfg = loadWebConfig(process.env);
  const cacheDir = process.env.WEB_CACHE_DIR || join(MCP_DIR, '.cache', 'web');
  const search = new AiSearch({
    cfg,
    cacheDir,
    logFile: join(cacheDir, 'linklog.jsonl'),
    priorFile: join(cacheDir, 'prior.json'),
  });

  const dashboard = new Dashboard({ tty: process.stdout.isTTY === true && !opts.text });
  await search.init();

  let final = null;
  try {
    final = await searchWithDashboard(search, { query }, { dashboard });
  } catch (err) {
    dashboard.pushLog(`błąd: ${err.message}`, 'red');
    dashboard.renderText(true);
    process.exitCode = 1;
  } finally {
    dashboard.renderText(true);
    await search.flush();
    if (!dashboard.tty) {
      // tekstowy tryb: podsumowanie na końcu, żeby potok był czytelny
      const out = [];
      out.push('');
      out.push(`── AiSearch ── "${final?.query ?? query}"`);
      out.push(`intencje: ${final?.intents?.join(', ') ?? '-'}`);
      out.push(`kandydaci: ${final?.stats?.candidates ?? 0} · zweryfikowane: ${final?.stats?.verified ?? 0} · odrzucone: ${final?.stats?.rejected ?? 0}`);
      out.push(`cache: ${final?.stats?.cacheHits ?? 0} trafień · requesty: ${final?.stats?.requests ?? 0} · czas: ${final?.stats?.ms ?? 0} ms`);
      out.push(`pokrycie: ${final?.coverage ?? 0}${final?.empty ? ' (zero wyników — legalna odpowiedź)' : ''}`);
      out.push('');
      for (const r of final?.results ?? []) {
        const flags = [r.repaired ? 'naprawiony' : null, r.archived ? 'archiwum' : null, r.fromCache ? 'cache' : null].filter(Boolean).join(', ');
        out.push(`  ${String(r.rank).padStart(2)}. ${(r.score ?? 0).toFixed(2)}  ${r.title ?? '(bez tytułu)'}`);
        out.push(`      ${r.url}${flags ? `   [${flags}]` : ''}`);
      }
      if (final?.notes?.length) out.push('', 'uwagi:', ...final.notes.map((n) => `  - ${n}`));
      if (final?.drift?.length) out.push('', 'drift dokumentacji:', ...final.drift.map((d) => `  - ${d.domain}: redirect ${Math.round(d.redirectRatio * 100)}%`));
      process.stdout.write(`${out.join('\n')}\n`);
    }
  }

  if (dashboard.tty) dashboard.close();
  return final;
}
