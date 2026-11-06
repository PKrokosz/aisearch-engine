# AiSearch — zamknięty ekosystem wyszukiwania + przeglądarka dla agentów

<p align="center">
  <strong>Model zgaduje adresy. HTTP je weryfikuje i naprawia. Nic nie jest prawdą, dopóki serwer tego nie potwierdzi.</strong>
</p>

<p align="center">
  <img alt="CI" src="https://github.com/PKrokosz/aisearch-engine/actions/workflows/ci.yml/badge.svg">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-blue.svg">
  <img alt="node" src="https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg">
  <img alt="python" src="https://img.shields.io/badge/python-%3E%3D3.11-blue.svg">
  <img alt="deps" src="https://img.shields.io/badge/runtime%20deps-0-brightgreen.svg">
  <img alt="tests" src="https://img.shields.io/badge/tests-78-brightgreen.svg">
  <img alt="eval gate" src="https://img.shields.io/badge/eval%20gate-PASS-success.svg">
  <img alt="PRs welcome" src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg">
</p>

Zamknięty ekosystem wyszukiwania dla agentów AI: **plan → propose → resolve → falsify → [SERP] → learn**, z autokorektorem (redirect/Wayback), trzema cache'ami, feedami, nauką źródeł i detektorem driftu dokumentacji. Tam gdzie tekst się nie przewija (JS, SPA), wchodzi przeglądarka **Obscura** (V8) — a werdykt zawsze zostaje po stronie silnika. Jeden serwer MCP, trzy wejścia (MCP/HTTP/CLI), zero zależności runtime.

To nie jest kopia ani „jeszcze jeden wrapper". To **synteza dwóch dojrzałych
podejść** w jednym czystym repo:

| Warstwa | Skąd | Co wzięliśmy |
|---|---|---|
| **Mózg** — pipeline `plan→propose→resolve→falsify→rank→[SERP]→learn→out`, 3 cache'e, feedindex, prior/drift, ewaluacja z bramką CI | `pkrokosz.pl/mcp/src/web/` (AiSearch) | cały rdzeń — jeden do jednego, z 49 testami i zielonym gate'm |
| **Ręce** — przeglądarka headless (38 narzędzi), render jako eskalacja | `agentmg/tools/obscura/` (Obscura) | klient MCP + polityka renderowania + passthrough narzędzi `browser_*` |
| **Interfejsy** — jeden silnik, trzy wejścia | oba źródła | MCP stdio + HTTP + CLI-bridge; sandbox Python (tylko przestrzeń `web`) |

**Bez szumu** — celowo usunięte: narzędzia YouTube (mają własne repo
`youtube-transcript-search`), przestrzenie sandboxu niebędące `web`
(posts/projects/agentmg…), zależności runtime (**zero** — `npm install` niepotrzebny),
fork SDK MCP (JSON-RPC 2.0 po liniach napisany ręcznie — 4 metody, nie biblioteka),
domeny własne w kodzie (przez `WEB_SOURCE_LOCAL`), PHP-warstwa (repo ją dostarcza
samo, jeśli chce).

## Szybki start

```bash
# 1. Bramka jakości — offline, deterministyczna (CI)
npm run eval            # replay + gate: hit_rate, repair_rate, false_positive
npm test                # wszystkie testy (Node + Python), bez sieci

# 2. Dashboard / ślad decyzji w języku naturalnym
npm run dashboard "PHP 8.4 release announcement changelog"

# 3. Serwer MCP dla agenta (opencode / Claude / inne)
#    package.json "bin": aisearch → src/mcp/server.mjs
#    albo ręcznie: node src/mcp/server.mjs
```

### Rejestracja MCP (opencode / Claude)

```json
{
  "mcpServers": {
    "aisearch": {
      "command": "node",
      "args": ["C:/Users/admin/Desktop/aisearch/src/mcp/server.mjs"]
    }
  }
}
```

### Warstwa HTTP (sandbox, debug, integracje)

```bash
npm run http                                   # http://127.0.0.1:8787
curl -H "authorization: Bearer $WEB_API_KEY" http://127.0.0.1:8787/web/stats
```

## Narzędzia (jeden serwer, dwa światy)

**Silnik (`web.*`)** — 13 narzędzi:

| Narzędzie | Po co |
|---|---|
| `web.search` | cały pipeline; wynik = ranked + provenance + ślad decyzji |
| `web.brief` | jedno wywołanie → zwinięty brief (rank/score/flags) |
| `web.verify_links` | partia kandydatów w jednym callu: survived/rejected/repaired |
| `web.drift_report` | drift dokumentacji + prior + werdykt w języku naturalnym |
| `web.render` | render jednej strony przez V8 (jawny, drogi) |
| `web.trace` | pełny ślad etapów — do debugowania „co się zadziało" |
| `web.feedback` | pętla użyteczności: used/ignored/rejected → prior |
| `web.eval` | metryki jakości + werdykt bramki (replay/live) |
| `web.stats` · `web.drift` · `web.cache` · `web.feeds` · `web.configure` | widok wnętrza ekosystemu |

**Przeglądarka (`browser_*`)** — pełny passthrough Obscury (`browser_navigate`,
`browser_markdown`, `browser_links`, `browser_click`, `browser_fill`, `browser_evaluate`,
`browser_screenshot`, `browser_pdf`, zakładki…). Lista zależy od zainstalowanej wersji
binarii. Gdy binaria nie ma — serwer i tak działa, tylko `web.*`.

## Jak współpracują mózg i ręce

```
plan → propose → resolve (fetch, redirecty, cache) → renderPass (Obscura, auto) → falsify → rank → [SERP] → learn → out
                                                    └── tylko JS-shelle: 200, ale treści < WEB_RENDER_MIN_TEXT
```

Zasady (wynikione z pułapek obu światów, opis w `docs/ARCHITECTURE.md`):
1. **Fetch zostaje na głównej ścieżce** — szybki, liczy redirecty (na nich stoi
   detektor driftu), deterministyczny w replay.
2. **Przeglądarka eskalacjią, nie fetcherem** — `walkRedirects` liczy hop'y;
   przeglądarka followuje je po cichu i zepsułaby ten licznik.
3. **Budżet i jawność** — `WEB_RENDER_MAX` (domyślnie 3) na zapytanie; tryb
   `all` tylko świadomie; błąd przeglądarki nie wywala pipeline'u.
4. **Replay jest czysty** — bez renderera nie ma requestów: ewaluacja offline
   pozostaje deterministyczna, bramka CI nie może „pogięzić" wyniku siecią.

## Sandbox Python (receptury)

```bash
python src/sandbox/launch.py --recipe web_search_brief --args '{"query":"PHP 8.4 release changelog"}'
python src/sandbox/launch.py --recipe web_verify_links  --args '{"urls":["https://www.php.net/releases/8.4/en.php","https://ten-url-nie-istnieje.example"]}'
python src/sandbox/launch.py --recipe web_render_page  --args '{"url":"https://example.com"}'
```

Receptury: `web_search_brief`, `web_verify_links`, `web_drift_report`,
`web_render_page`. Antywzorzec: model pcha **jedno** wywołanie, partia dzieje
się w silniu. Sesje (`--workspace --session ID`) trzymają `WORKSPACE` między
wywołaniami (TTL 15 min, max 50). W repo jest tylko przestrzeń `web` —
reszta sandboxu jest celowo pusta.

## Bramki

```bash
npm run syntax         # node --check + py_compile na wszystkim
npm run test:unit      # browser/render, serwer MCP (ze stubem), HTTP/bridge
npm run test:web       # 49 testów rdzenia (plan/propose/resolve/falsify/cache/feeds/dashboard)
npm run test:py        # 10 testów receptur + 10 testów sesji/launchera (offline)
npm run eval           # ewaluacja replay + gate regresji
npm run eval:live      # to samo z prawdziwą siecią
```

Wynik na dziś: **syntax 0 błędów · 49 + 3 Node · 20 Python · eval gate PASS**.

## Layout

```
src/
  engine/     rdzeń AiSearch (16 modułów) + instance.mjs (wspólna instancja) + dashboard
  browser/    client.mjs (NDJSON MCP → Obscura) · render.mjs (polityka eskalacji)
  mcp/        server.mjs — jeden serwer: web.* + browser_* (zero zależności)
  http/       server.mjs (REST) · bridge.mjs (CLI stdin→stdout)
  sandbox/    client.py · launch.py · tools.py (mock) · sessions.py · redact.py · recipes/
test/         testy Node (stub Obscury w test/stub-obscura.mjs)
fixtures/     web-eval.json — nagrania do deterministycznego replay
scripts/      web-eval.mjs · check-syntax.mjs
bin/          tutaj ląduje obscura.exe (gitignored — pobierz z Releases)
docs/         ARCHITECTURE.md
```

## Wymagania

- Node ≥ 20 (do silnika, MCP, HTTP, testów)
- Python ≥ 3.11 (sandbox + receptury; tylko stdlib)
- Obscura **opcjonalna** — bez niej silnik działa (fetch, SERP, nauka), render
  i `browser_*` są wyłączone. Binaria: GitHub Releases projektu
  [Obscura](https://github.com/h4ckf0r0day/obscura) → `bin/` albo `OBSCURA_BIN`.

## Konfiguracja

Pełna lista z komentarzami: `.env.example` (→ `.env`, nigdy do gita). Najważniejsze:
`WEB_RENDER` (auto/all/off), `WEB_RENDER_MAX`, `WEB_SERP_ENABLED`,
`WEB_COVERAGE_THRESHOLD`, `WEB_CONCURRENCY`, `WEB_HTTP_PORT`, `WEB_API_KEY`.
