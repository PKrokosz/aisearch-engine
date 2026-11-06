#!/usr/bin/env python3
"""
sandbox/client.py — cienki klient silnika dla przepisów (bezpieczna przestrzeń).

Antywzorzec: model NIE woła sieci w pętli. Dostaje JEDNO wywołanie narzędzia,
a partię (resolve równolegle, single-flight, auto-korektor) robi silnik.
Ten moduł tłumaczy wygodną przestrzeń `web` na HTTP do lokalnego serwera
silnika (domyślnie http://127.0.0.1:8787) i pilnuje:
  - allowlisty (tylko metody web.*),
  - licznika wywołań (budżet modelu),
  - redakcji sekretów na wyjściu (redact.py).
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request

from redact import redact

ALLOWED = {
    "web.search", "web.trace", "web.brief", "web.verify_links",
    "web.drift_report", "web.render", "web.stats", "web.drift",
    "web.feeds", "web.eval", "web.feedback",
}


class NotAllowed(Exception):
    pass


class BudgetExceeded(Exception):
    pass


class Shim:
    """Rodzic dla przestrzeni `web` — HTTP, budżet, allowlista."""

    def __init__(self, base_url=None, api_key=None, max_calls=25, timeout=30.0):
        self.base_url = (base_url or os.environ.get("WEB_API_URL") or "http://127.0.0.1:8787").rstrip("/")
        self.api_key = api_key or os.environ.get("WEB_API_KEY", "")
        self.max_calls = max_calls
        self.timeout = timeout
        self.calls = 0
        self.dry_run = False

    # -- wewnętrzne -----------------------------------------------------
    def _check_allowed(self, tool: str) -> None:
        if tool not in ALLOWED:
            raise NotAllowed(f"narzędzie poza allowlistą: {tool}")

    def _increment(self) -> None:
        self.calls += 1
        if self.calls > self.max_calls:
            raise BudgetExceeded(f"budżet wywołań ({self.max_calls}) wyczerpany")

    def _http(self, method: str, route: str, body=None):
        url = f"{self.base_url}/{route.lstrip('/')}"
        data = json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("content-type", "application/json")
        req.add_header("accept", "application/json")
        if self.api_key:
            req.add_header("authorization", f"Bearer {self.api_key}")
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as res:
                payload = json.loads(res.read().decode("utf-8") or "{}")
        except urllib.error.HTTPError as e:
            payload = {"ok": False, "error": f"HTTP {e.code}: {e.read().decode('utf-8')[:200]}"}
        except urllib.error.URLError as e:
            payload = {"ok": False, "error": f"serwer silnika niedostępny ({e.reason}) — uruchom: node src/http/server.mjs"}
        return redact(payload)


class Web:
    """Przestrzeń `web` dla przepisów — 1:1 z trasami silnika."""

    def __init__(self, parent: Shim):
        self._p = parent

    def search(self, query, urls=None, intents=None, staleness=None, limit=None, top=5, serp=None, render=None):
        self._p._check_allowed("web.search")
        self._p._increment()
        body: dict = {"query": query, "top": top}
        if urls is not None:
            body["urls"] = list(urls)
        if intents is not None:
            body["intents"] = list(intents)
        if staleness is not None:
            body["staleness"] = staleness
        if limit is not None:
            body["limit"] = limit
        if serp is not None:
            body["serp"] = serp
        if render is not None:
            body["render"] = render
        return self._p._http("POST", "web/search", body)

    def brief(self, query, urls=None, top=5):
        self._p._check_allowed("web.brief")
        self._p._increment()
        return self._p._http("POST", "web/brief", {"query": query, "urls": urls, "top": top})

    def verify_links(self, query, urls, top=None, serp=False):
        self._p._check_allowed("web.verify_links")
        self._p._increment()
        return self._p._http("POST", "web/verify_links", {
            "query": query, "urls": list(urls), "top": top or len(urls), "serp": serp,
        })

    def drift_report(self, threshold=None):
        self._p._check_allowed("web.drift_report")
        self._p._increment()
        return self._p._http("POST", "web/drift_report", {"threshold": threshold})

    def render(self, url, timeout_ms=None):
        self._p._check_allowed("web.render")
        self._p._increment()
        return self._p._http("POST", "web/render", {"url": url, "timeoutMs": timeout_ms})

    def trace(self, query, urls=None, top=5):
        self._p._check_allowed("web.trace")
        self._p._increment()
        return self._p._http("POST", "web/trace", {"query": query, "urls": urls, "top": top})

    def stats(self):
        self._p._check_allowed("web.stats")
        self._p._increment()
        return self._p._http("GET", "web/stats")

    def drift(self, threshold=None):
        self._p._check_allowed("web.drift")
        self._p._increment()
        return self._p._http("GET", "web/drift")

    def feeds(self, action="list", url=None, intent=None, name=None):
        self._p._check_allowed("web.feeds")
        self._p._increment()
        body = {"action": action}
        if url:
            body["url"] = url
        if intent:
            body["intent"] = intent
        if name:
            body["name"] = name
        return self._p._http("POST", "web/feeds", body)

    def eval(self, mode="replay", gate=True):
        self._p._check_allowed("web.eval")
        self._p._increment()
        return self._p._http("GET", f"web/eval?mode={mode}&gate={'1' if gate else '0'}")

    def feedback(self, url, label, query=""):
        self._p._check_allowed("web.feedback")
        self._p._increment()
        return self._p._http("POST", "web/feedback", {"url": url, "label": label, "query": query})


def make_shim(**kwargs) -> Shim:
    shim = Shim(**kwargs)
    shim.web = Web(shim)
    return shim
