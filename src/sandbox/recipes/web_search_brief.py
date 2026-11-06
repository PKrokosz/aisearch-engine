#!/usr/bin/env python3
"""
Recipe: web_search_brief — jedno wywołanie → zwinięty brief z provenance.

Model pcha JEDNO wywołanie; cała partia dzieje się w silniu AiSearch
(plan → kandydaci → resolve równolegle → falsify → rank → learn).
Dotyga do tej samej treści co narzędzie web.brief — przepis pokazuje wzorzec
dla receptur własnych (filtrowanie, formatowanie, pożytek dla modelu).

Args (płaskie globals):
  query (str) · urls (list, opcjonalnie) · top? (int, domyślnie 5)

Zwraca w RESULT: {ok, query, coverage, empty, brief[{rank,title,url,score,
intent,domain,repaired,archived,rendered,fromCache}], notes, stats}
"""
_query = globals().get("query") or ""
if not _query:
    RESULT = {"ok": False, "error": "args.query jest wymagane"}
else:
    _res = web.brief(_query, urls=globals().get("urls"), top=globals().get("top") or 5)
    if not isinstance(_res, dict):
        RESULT = {"ok": False, "error": "web.brief zwrócił nie-dict"}
    else:
        RESULT = {
            "ok": _res.get("ok", False),
            "query": _res.get("query", _query),
            "coverage": _res.get("coverage", 0),
            "empty": _res.get("empty", True),
            "brief": _res.get("brief") or [],
            "notes": _res.get("notes") or [],
            "stats": _res.get("stats") or {},
        }
