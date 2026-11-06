# AiSearch — architektura

> Model **zgaduje** adresy, HTTP je **weryfikuje i naprawia**. Nic nie jest prawdą,
> dopóki serwer tego nie potwierdzi. Tam gdzie fetch się nie przewija — V8 (Obscura).
> Implementacja: `src/` · Narzędzia: `web.*` (+ `browser_*`) · Bramka: `npm run eval`

## 1. Ekosystem: `in → AiSearch → out`

```
Ty/agent → QuerySpec ──► AiSearch ────────────────────────► Results + provenance
                        │
   plan → propose → resolve → [renderPass] → falsify → rank → [SERP] → learn
            │          │           │                        │          │
          feeds      cache      Obscura                   linklog ←──┘
          prior    redirecty    (V8, auto            prior → drift
                    Wayback     tylko JS-shelle)          │
                                                      obniża wagę
                                                   w propose
```

Route wyjścia: HTTP, Wayback, feedi i — jawne, logowane, mierzone — SERP jako
escape hatch. Żadnego klucza API na ścieżce krytynej. Render dodaje V8, ale nie
zmienia zasad: werdykt zawsze po stronie falsify.

## 2. Moduły i kontrakty

| Moduł | Wejście → Wyjście | Sieć | Uwagi |
|---|---|---|---|
| `types.mjs` | słownictwo, normalizacja, konfiguracja | nie | pure |
| `plan.mjs` | `QuerySpec` → `Plan` | nie | pure |
| `propose.mjs` | `Plan` → `Candidate[]` | 0–1/źródło | inline/feeds/prior/(llm) |
| `resolve.mjs` | `Candidate[]` → `Resolved[]` | tak | ręczny chód po redirectach, warianty, Wayback, single-flight |
| `browser/render.mjs` | `Resolved[]` → renderowane | tak | **nowe**: eskalacja V8, budżet, tryby auto/all/off |
| `browser/client.mjs` | NDJSON MCP → metody | tak | **nowe**: klient Obscury, timeout per call |
| `falsify.mjs` | `Resolved[]` → `Verified[]` | nie | fixture HTML |
| `serp.mjs` | query → `Candidate[]` | tak | escape hatch |
| `learn.mjs` | linklog → prior/drift | nie | uczy się źródeł, nie URL-i |
| `cache.mjs` | rejestry TTL/LRU | nie | 3 cache'e + single-flight |
| `feedindex.mjs` | rejestr → `match()` | tak | RSS/Atom, conditional GET |
| `eval.mjs` | korpus → metryki | replay/live | deterministyczny replay |
| `pipeline.mjs` | orkiestrator + zdarzenia | pośrednio | generator zdarzeń → dashboard |
| `instance.mjs` | wspólna instancja | pośrednio | **nowe**: MCP/HTTP/bridge + leniwy renderer |
| `dashboard.mjs` | zdarzenia → TUI/tekst | nie | `narrate()` = ten sam strumień jako tekst |

## 3. Cache i ewaluacja

3 cache'e — osobne TTL, bo osobne problemy:

| Cache | Klucz | TTL | Inwalidacja |
|---|---|---|---|
| resolve | znormalizowany requested URL | 6 h; negatywy 15 min | próg, `web.cache clear` |
| content | canonical URL | 24 h | LRU max 2000 |
| feedindex | URL feeda | 15 min–6 h | `ETag/Last-Modified` → 304 = zero transferu |

Stale-while-error: pad sieci ≠ pusta odpowiedź.

**A. Jakość szukania** (`web.eval`): `hit_rate`, `repair_rate` (ile wyników
istnieje tylko dzięki korektorze), `hallucination_block`, `false_positive`
(najgroźniejszy tryb awarii), `precision@3`, `expectations_met`, `fallback_rate`.
Kontrolna para w korpusie: zapytania, gdzie poprawną odpowiedzią jest ZERO.
**B. Użyteczność** (`web.feedback`) → linklog → prior. Rozdzielczość ≠ pomocność.

## 4. Renderowanie — dlaczego osobny przebieg, nie wstrzyknięty fetcher

`resolve.mjs` chodzi po redirectach RĘCZNIE, żeby znać liczbę hopów — na tym
stoi detektor driftu. Przeglądarka followuje redirecty po cichu: wstrzyknięta
jako fetcher zgubiłaby ten licznik. Dlatego:

```
resolve (fetch, redirecty, cache) → renderPass → falsify (werdykt PO renderze)
```

- **Tryby**: `auto` (200, ale treści < `WEB_RENDER_MIN_TEXT`) · `all` (świadomie,
  drogo) · `off` (domyślny bez renderera).
- **Budżet**: `WEB_RENDER_MAX` na zapytanie (domyślnie 3), timeout per strona.
- **Izolacja awarii**: błąd/brak korzyści z przeglądarki → wynik zostaje z fetch,
  event `render-error/skip` w śladzie, pipeline idzie dalej.
- **Determinizm**: replay nie ma renderera → zero requestów → CI stabilne.
- **Koszt**: render = proces + sekundy; dlatego partia kandydatów idzie przez
  fetch, a render jest JAWNY (`web.render`, `web_render_page`).

## 5. Jedna silnik, trzy wejścia

```
MCP (stdio, src/mcp/server.mjs)   ─┐
HTTP (REST, src/http/server.mjs)  ─┼─► AiSearchInstance (jeden cache/prior/historia)
CLI (bridge, src/http/bridge.mjs) ─┘        │
                                            ├─► browser/render.mjs (leniwy)
Python sandbox (launch.py + recipes) ───────┘
```

Cache i prior są **wspólne**: zapytanie przez HTTP uczy się z tego, czego nauczył
się agent MCP — i odwrotnie. Renderer jest leniwy: czyste `web.*` nie startuje
przeglądarki; startuje ją pierwszy render lub pierwsze `browser_*`.

## 6. Sandbox Python

```
model ──JEDNO wywołanie──► runtime launcher ──► przepis (recipes/*.py)
   │                                              │
   │                                        exec w globals:
   │                                        {web, shim, RESULT, WORKSPACE}
   │                                              │
   └──────────── zwinięty RESULT + telemetry ◄─────┘
```

- `client.py` — przestrzeń `web` (11 metod) + allowlista + budżet + redakcja sekretów.
- `launch.py` — proces izolowany (`python -I`), `--recipe`/`--code`, `--dry-run`, sesje.
- `sessions.py` — `WORKSPACE` trwały między wywołaniami (TTL 15 min, max 50).
- `tools.py` — mock (ten sam kształt odpowiedzi, zero sieci) — testy deterministyczne.
- Bezpieczeństwo przez konstrukcję: repo wystawia TYLKO przestrzeń `web`.

## 7. Pułapki (naprawione — nie wracać)

1. **Przeglądarka jako fetcher** zabijałaby licznik redirectów (drift). Render jest
   osobnym przebiegiem (patrz §4).
2. **`yield` wewnątrz arrow-function** nie kompiluje się — zdarzenia renderu zbieramy
   do tablicy i yield'ujemy po przebiegu (wzorzec `propose/resolve` w tym samym pliku).
3. **PowerShell przekłamuje encodowanie** (`Get-Content`/`Set-Content` bez `-Encoding utf8`
   czyta UTF-8 jako ANSI → „trafieĹ„"). Nagłówki i przepisy edytujemy przez Node/`write`,
   nigdy przez przekierowanie PowerShell. Bramka: `npm run syntax` + testy z diakrytykami.
4. **Time-outy w teście MCP** trzymały proces 15 s po zakończeniu testu — czyścimy
   `clearTimeout` po sukcesie (poukładało to `duration_ms` z 15 300 → 220 ms).
5. **Mock verify_links** porównywał tylko `url` — naprawiony redirectem kandydat
  (`requestedUrl` ≠ canonical) wyglądał jak odrzucony. Porównujemy oba pola.
6. **Pretty-JSON mostka** w wielu liniach — parser bierze CAŁY stdout, nie ostatnią linię.
7. **Spawn `.mjs` na Windows** pada (nie jest exe) — klient rozpoznaje skrypty i startuje
   je przez `process.execPath` (obscura.exe zostaje bez zmian).

## 8. Skąd się wzięło (provenance merge)

- **Rdzeń silnika** (`src/engine/*`): `pkrokosz.pl/mcp/src/web/` — moduły 1:1,
  zaadaptowane ścieżki (`MCP_DIR` = korzeń repo) i `SOURCE_FAMILIES.local-pl`
  z kodu → `WEB_SOURCE_LOCAL`.
- **Przeglądarka** (`src/browser/*`): `agentmg/tools/obscura/` — wzorzec klienta
  NDJSON z `e2e.mjs`/wrappera, uproszczony do potrzeb silnika; polityka renderu
  oraz passthrough `browser_*` — nowe.
- **Interfejsy**: fasada narzędzi (`src/mcp/server.mjs`) zastępuje fork SDK MCP —
  własny JSON-RPC 2.0 po liniach, zero zależności; HTTP/bridge — kontrakt mostkowy
  z `api-bridge.mjs`, na wspólnej instancji (`instance.mjs`).
- **Usunięte celowo**: YouTube (osobne repo), namespaces sandboxu poza `web`,
  SDK MCP, zależności npm, warstwa PHP, `dashboard-cli` calls do `src/index.mjs`.
