#!/usr/bin/env python3
"""
Recipe: web_drift_report — drift + prior + werdykt w języku naturalnym.

Detektor driftu dokumentacji: domeny, które zaczęły przekierowywać = właśnie
się przestawiły. Sygnału nie kupisz w żadnym płatnym API — wychodzi z własnego
linklogu. Werdykt jest gotowy dla człowieka, nie dla parsera.

Args (płaskie globals): threshold? (float, domyślnie z konfiguracji)

Zwraca w RESULT: {ok, threshold, drift[], priorTop[], verdict}
"""
_res = web.drift_report(threshold=globals().get("threshold"))
if not isinstance(_res, dict):
    RESULT = {"ok": False, "error": "web.drift_report zwrócił nie-dict"}
else:
    RESULT = {
        "ok": _res.get("ok", False),
        "threshold": _res.get("threshold", 0.25),
        "drift": _res.get("drift") or [],
        "priorTop": _res.get("priorTop") or [],
        "verdict": _res.get("verdict", ""),
    }
