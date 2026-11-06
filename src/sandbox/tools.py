#!/usr/bin/env python3
"""
sandbox/tools.py — MOCK przestrzeni `web` (bez sieci, deterministyczny).

Ten sam kształt odpowiedzi co silnik, zero requestów. Służy testom przepisów
i trybowi dry-run: przepis jest agnostyczny względem mocka/prawdy.
"""

_WEB_CANNED = [
    {
        "rank": 1,
        "url": "https://www.php.net/releases/8.4/en.php",
        "requestedUrl": "https://www.php.net/releases/8.4/en.php",
        "title": "PHP: PHP 8.4 Release Announcement",
        "score": 0.675,
        "intent": "changelog",
        "proposedBy": "inline",
        "repaired": False,
        "redirects": 0,
        "archived": False,
        "fromCache": False,
        "rendered": False,
        "domain": "php.net",
    },
    {
        "rank": 2,
        "url": "https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/If-None-Match",
        "requestedUrl": "https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/If-None-Match",
        "title": "If-None-Match header - HTTP | MDN",
        "score": 0.66,
        "intent": "official-docs",
        "proposedBy": "inline",
        "repaired": True,  # stara ścieżka naprawiona przez 301-redirect
        "redirects": 1,
        "archived": False,
        "fromCache": False,
        "rendered": True,  # ten wynik wyciągnęła przeglądarka
        "domain": "developer.mozilla.org",
    },
]


class MockShim:
    """Zbierak wywołań + przestrzeń web z gotowymi odpowiedziami."""

    def __init__(self):
        self.calls = []
        self.dry_run = True
        self.web = MockWeb(self)


class MockWeb:
    def __init__(self, parent):
        self._p = parent

    def _log(self, tool, **kw):
        self._p.calls.append({"tool": tool, "kwargs": kw})

    def search(self, query, urls=None, intents=None, staleness=None, limit=None, top=5, serp=None, render=None):
        self._log("web.search", query=query, top=top, urls=urls)
        kept = _WEB_CANNED[: max(0, int(top))]
        requested = list(urls or [])
        rejected = [
            u for u in requested
            if u.replace("https://", "").replace("http://", "") not in
            " ".join(r["url"] + " " + r.get("requestedUrl", "") for r in kept)
        ]
        return {
            "ok": True, "query": query, "intents": ["changelog"],
            "results": kept, "coverage": 0.66, "empty": len(kept) == 0,
            "stats": {"candidates": len(requested), "verified": len(requested) - len(rejected),
                      "requests": len(requested), "cacheHits": 0, "renders": 1, "ms": 400},
            "rejected": rejected,
        }

    def brief(self, query, urls=None, top=5):
        res = self.search(query, urls=urls, top=top)
        self._log("web.brief", query=query, top=top)
        return {"ok": True, "query": query, "coverage": res["coverage"], "empty": res["empty"], "brief": res["results"], "notes": []}

    def verify_links(self, query, urls, top=None, serp=False):
        res = self.search(query, urls=urls, top=top or len(urls))
        self._log("web.verify_links", query=query, urls=urls)
        # przeżywa zarówno canonical (url), jak i requestedUrl — naprawiony
        # redirectem URL jest SURVIVED, nie rejected.
        kept_keys = " ".join(r["url"] + " " + r.get("requestedUrl", "") for r in res["results"])
        norm = lambda s: s.replace("https://", "").replace("http://", "")
        rejected = [u for u in urls if norm(u) not in norm(kept_keys)]
        repaired = [r["url"] for r in res["results"] if r.get("repaired")]
        return {
            "ok": True, "query": query, "total": len(urls),
            "survived": res["results"], "rejected": rejected, "repaired": repaired,
            "counts": {"survived": len(res["results"]), "rejected": len(rejected),
                       "repaired": len(repaired), "requests": (res.get("stats") or {}).get("requests", 0)},
        }

    def drift_report(self, threshold=None):
        self._log("web.drift_report", threshold=threshold)
        return {"ok": True, "threshold": threshold or 0.25, "drift": [], "priorTop": [], "verdict": "OK (mock): brak driftu w trybie offline."}

    def render(self, url, timeout_ms=None):
        self._log("web.render", url=url)
        return {"ok": True, "url": url, "title": "Rendered by mock", "text": "# Mock\n\ntreść", "length": 11}

    def trace(self, query, urls=None, top=5):
        self._log("web.trace", query=query)
        return {"ok": True, "query": query, "results": [], "trace": ["[plan] mock", "[final] mock"], "stats": {}}

    def stats(self):
        self._log("web.stats")
        return {"ok": True, "cache": {"resolve": {"hits": 3}}, "prior": {"entries": 0}, "drift": [], "sessionSearches": 1}

    def drift(self, threshold=None):
        self._log("web.drift")
        return {"ok": True, "threshold": threshold or 0.25, "drift": []}

    def feeds(self, action="list", **kw):
        self._log("web.feeds", action=action)
        return {"ok": True, "feeds": [], "snapshot": {}}

    def eval(self, mode="replay", gate=True):
        self._log("web.eval", mode=mode)
        return {"ok": True, "totals": {}, "gate": {"pass": True, "failures": []}}

    def feedback(self, url, label, query=""):
        self._log("web.feedback", url=url, label=label)
        return {"ok": True, "url": url, "label": label, "priorEntries": 1}
