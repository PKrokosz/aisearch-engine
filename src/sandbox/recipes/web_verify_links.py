#!/usr/bin/env python3
"""
Recipe: web_verify_links — partia kandydatów w JEDNYM wywołaniu.

ANTYWZORZEC eliminowany: zamiast N wywołań (jeden per URL) model pcha JEDNO,
a partia idzie równolegle w środku silnika (resolve z limitem współbieżności,
single-flight, auto-korektor redirect/Wayback). serp domyślnie wyłączony —
tu celowo bez wynalazków z SERP.

Args (płaskie globals):
  query (str) · urls (list, max 20) · top? (int) · serp? (bool, domyślnie False)

Zwraca w RESULT: {ok, query, total, survived[], rejected[], repaired[], counts}
To jest dowód sensu auto-korektora: stara ścieżka MDN przeżywa dzięki
301-redirect (0 dodatkowych requestów), a wymyślony URL ginie w ~250 ms.
"""
_urls = globals().get("urls") or []
if not isinstance(_urls, list):
    RESULT = {"ok": False, "error": "args.urls musi być listą"}
else:
    _urls = [str(u).strip() for u in _urls
             if str(u).strip().startswith(("http://", "https://"))][:20]
    if not _urls:
        RESULT = {"ok": True, "query": globals().get("query", ""), "total": 0,
                  "survived": [], "rejected": [], "repaired": [],
                  "counts": {"survived": 0, "rejected": 0, "repaired": 0, "requests": 0}}
    else:
        _res = web.verify_links(
            globals().get("query") or "weryfikacja kandydatów",
            _urls,
            top=globals().get("top") or len(_urls),
            serp=globals().get("serp") or False,
        )
        if not isinstance(_res, dict):
            RESULT = {"ok": False, "error": "web.verify_links zwrócił nie-dict"}
        else:
            RESULT = {
                "ok": True,
                "query": _res.get("query", ""),
                "total": len(_urls),
                "survived": _res.get("survived") or [],
                "rejected": _res.get("rejected") or [],
                "repaired": _res.get("repaired") or [],
                "counts": _res.get("counts") or {},
            }
