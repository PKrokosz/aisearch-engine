/**
 * scripts/web-eval.mjs — CLI ewaluatora AiSearch.
 *
 *   node scripts/web-eval.mjs            # tryb replay (CI, bez sieci)
 *   node scripts/web-eval.mjs --live     # prawdziwa siec
 *   node scripts/web-eval.mjs --gate     # replay + bramka regresji (exit 1 przy fail)
 *
 * Wyjscie: tabela metryk + werdykt bramki. Zero zaleznosci poza samym MCP.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadFixtures, buildReplayFetcher, runEval, evalGate } from '../src/engine/eval.mjs';
import { planQuery } from '../src/engine/plan.mjs';
import { WebCache } from '../src/engine/cache.mjs';
import { loadWebConfig } from '../src/engine/types.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesFile = join(__dirname, '..', 'fixtures', 'web-eval.json');

const args = process.argv.slice(2);
const mode = args.includes('--live') ? 'live' : 'replay';
const gate = args.includes('--gate');

const cfg = loadWebConfig(process.env);
if (mode === 'replay') cfg.serpEnabled = false; // nagrania sa kompletne; SERP tylko w live
const cacheDir = join(__dirname, '..', '.cache', 'web-eval');
const cache = new WebCache(cacheDir);
await cache.load();

const fixtures = await loadFixtures(fixturesFile);
const fetcher = mode === 'replay' ? buildReplayFetcher(fixtures.responses).fetcher : globalThis.fetch;

const result = await runEval({ fixtures, ctx: { cfg, cache, fetcher }, mode });

const row = (r) =>
  [
    (r.query || '').slice(0, 38).padEnd(38),
    String(r.candidates).padStart(4),
    String(r.verified).padStart(5),
    String(r.rejected).padStart(5),
    String(r.repaired).padStart(5),
    String(r.kept).padStart(4),
    (r.coverage ?? 0).toFixed(2).padStart(6),
    r.serpUsed ? 'SERP' : r.expectEmpty ? (r.kept === 0 ? 'OK(0)' : 'ZLE!') : r.matched > 0 ? 'OK' : 'ZLE!',
  ].join(' ');

console.log(`\n  AiSearch — ewaluacja (tryb: ${mode}${result.fixturesMeta?.recordedAt ? `, nagrania: ${result.fixturesMeta.recordedAt}` : ''})`);
console.log('  ─────────────────────────────────────────────────────────────────────────────────────────────');
console.log('  zapytanie'.padEnd(38), 'kandy', 'zwery', 'odrzu', 'napra', 'wynik', 'cover', 'werdykt');
console.log('  ─────────────────────────────────────────────────────────────────────────────────────────────');
for (const r of result.rows) console.log(' ', row(r));
console.log('  ─────────────────────────────────────────────────────────────────────────────────────────────');

const t = result.totals;
console.log(`\n  hit_rate            : ${t.hitRate}     (udzial kandydatow, ktore uzyskaly 200)`);
console.log(`  repair_rate         : ${t.repairRate}     (udzial wynikow, ktore istnieja dzieki redirect/Wayback — dowod sensu auto-korektora)`);
console.log(`  hallucination_block : ${t.hallucinationBlockRate}     (zgadywania 404/DNS poprawnie odrzucone w ~250 ms)`);
console.log(`  false_positive_rate : ${t.falsePositiveRate}     (200, ale off-topic — najgrozniejszy tryb awarii)`);
console.log(`  precision_at_3      : ${t.precisionAt3}`);
console.log(`  expectations_met    : ${t.expectationsMet}     (oczekiwania spelnione, liczac kontrole „zero wynikow")`);
console.log(`  fallback_rate       : ${t.fallbackRate}     (udzial zapytan uciekajacych do SERP — rosnie = ekosystem przestaje byc zamkniety)`);
console.log(`  avg_results         : ${t.avgResultsPerQuery}`);

if (gate) {
  const g = evalGate(result);
  console.log('');
  if (g.pass) {
    console.log('  BRAMKA: PASS (hit_rate, repair_rate, false_positive, expectations w progu)');
    process.exit(0);
  }
  console.log('  BRAMKA: FAIL');
  for (const f of g.failures) console.log(`    - ${f}`);
  process.exit(1);
}
