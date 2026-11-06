# Contributing

Krótko i konkretnie — repo jest debugowane jako "zero szumu", więc PR-y też.

## Zasady, których nie omijamy

1. **Determinizm replay jest święty.** Każda nowa sieciozależność wchodzi przez
   wstrzykiwany `fetcher`/renderer — bramka `npm run eval` musi być zielona offline.
2. **Redirecty liczy fetch.** Jeśli dodajesz korzystanie z przeglądarki — robisz to
   jako eskalację (`renderPass` / `web.render`), nie jako zamiennik fetchera
   w `resolve.mjs` (licznik hopów = detektor driftu).
3. **Błąd przeglądarki nie wywala pipeline'u** — zawsze try/catch + event w śladzie.
4. **Brak zależności runtime.** Stdlib Node i Pythona wystarczają; PR dodający
   npm-install wymaga uzasadnienia w opisie.
5. **Diakrytyki przez Node/`write`** — przekierowania PowerShell przekłamują UTF-8.
6. **Jeden silnik, trzy wejścia.** Nowa funkcja implementuje się w `instance.mjs`
   (tryb), a MCP/HTTP/bridge tylko ją publikują.

## Bramki (wszystkie muszą być zielone)

```bash
npm run syntax    # node --check + py_compile
npm run test:web  # 49 testów rdzenia
npm run test:unit # render/MCP/HTTP
npm run test:py   # 20 testów sandboxu (offline)
npm run eval      # replay + gate regresji
```

## PR

- Mały, jeden temat. Opis: problem → zmiana → jak sprawdzone.
- Test do każdej nowej zachowania (stub Obscury, mock fetcher, mock Web —
  wszystko offline).
