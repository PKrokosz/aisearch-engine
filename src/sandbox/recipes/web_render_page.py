#!/usr/bin/env python3
"""
Recipe: web_render_page — render jednej strony przez przeglądarkę (Obscura).

Nowa w syntezie: język tego przepisu jest ten sam co reszty (jedno wywołanie →
zwinięty wynik), a robota dzieje się w przeglądarce: V8 wykonuje JS, my bierzemy
markdown. Strona JS-owa, SPA, treść za interakcją.

UWAGA (koszt): przeglądarka startuje proces — to sekundy, nie milisekundy.
Dlatego render jest JAWNY: jeden URL, jeden cel. Duża partia kandydatów idzie
przez web.verify_links (fetch); render zostaje na podejrzane pojedynczo.

Args (płaskie globals): url (str) · timeout_ms? (int)

Zwraca w RESULT: {ok, url, title, text, length} albo {ok:false, error}
"""
_url = globals().get("url") or ""
if not _url.startswith(("http://", "https://")):
    RESULT = {"ok": False, "error": "args.url musi zaczynać się od http(s)://"}
else:
    _res = web.render(_url, timeout_ms=globals().get("timeout_ms"))
    if not isinstance(_res, dict):
        RESULT = {"ok": False, "error": "web.render zwrócił nie-dict"}
    else:
        RESULT = {
            "ok": _res.get("ok", False),
            "url": _res.get("url", _url),
            "title": _res.get("title"),
            "text": _res.get("text", ""),
            "length": _res.get("length", len(_res.get("text", ""))),
            "error": _res.get("error"),
        }
