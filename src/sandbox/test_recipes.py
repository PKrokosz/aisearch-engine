#!/usr/bin/env python3
"""
test_recipes.py — testy przepisów web_* (offline, mock shimia).

Uruchomienie: python src/sandbox/test_recipes.py
Wzorzec jak w testach jednostkowych: przepis exec'owany z mockami globals,
RESULT sprawdzany asercjami. Zero sieci, deterministycznie.
"""
from __future__ import annotations

import sys
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from tools import MockShim  # noqa: E402

RECIPES = Path(__file__).resolve().parent / "recipes"
PASSED = []
FAILED = []


def run_recipe(name: str, **args):
    """Exec przepisu z globals jak launch.py + zwraca (shim, result)."""
    shim = MockShim()
    code = (RECIPES / f"{name}.py").read_text(encoding="utf-8")
    globals_dict = {"web": shim.web, "shim": shim, "RESULT": None, "WORKSPACE": {}, "HISTORY": []}
    globals_dict.update(args)
    exec(code, globals_dict)
    return shim, globals_dict.get("RESULT")


def check(name: str, fn):
    try:
        fn()
        PASSED.append(name)
        print(f"[PASS] {name}")
    except AssertionError:
        FAILED.append((name, traceback.format_exc()))
        print(f"[FAIL] {name}\n{traceback.format_exc()}")
    except Exception:
        FAILED.append((name, traceback.format_exc()))
        print(f"[ERROR] {name}\n{traceback.format_exc()}")


# ── web_search_brief ────────────────────────────────────────────────
def t_brief():
    shim, res = run_recipe("web_search_brief", query="PHP 8.4 release announcement changelog", top=2)
    assert res["ok"] is True, res
    assert res["query"], res
    assert len(res["brief"]) == 2, res
    first = res["brief"][0]
    assert first["rank"] == 1 and "url" in first and "score" in first, first
    assert shim.calls and shim.calls[0]["tool"] == "web.search", shim.calls


def t_brief_no_query():
    _, res = run_recipe("web_search_brief")
    assert res == {"ok": False, "error": "args.query jest wymagane"}, res


# ── web_verify_links ────────────────────────────────────────────────
def t_verify():
    urls = [
        "https://www.php.net/releases/8.4/en.php",
        "https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/If-None-Match",
        "https://www.php.net/releases/8.4/en.php-nie-istnieje",
    ]
    _, res = run_recipe("web_verify_links", query="weryfikacja kandydatów", urls=urls, serp=False)
    assert res["ok"] is True and res["total"] == 3, res
    assert len(res["survived"]) == 2, res
    assert len(res["rejected"]) == 1 and res["rejected"][0] == urls[2], res
    assert res["repaired"] == ["https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/If-None-Match"], res
    assert res["counts"]["survived"] == 2, res


def t_verify_bad_args():
    _, res = run_recipe("web_verify_links", urls="nie lista")
    assert res["ok"] is False and "urls musi być listą" in res["error"], res


def t_verify_empty():
    _, res = run_recipe("web_verify_links", query="x", urls=[])
    assert res["ok"] is True and res["total"] == 0 and res["counts"]["survived"] == 0, res


def t_verify_skips_non_http():
    _, res = run_recipe("web_verify_links", query="x", urls=["ftp://x.y", "javascript:alert(1)"])
    assert res["total"] == 0, res


# ── web_drift_report ────────────────────────────────────────────────
def t_drift():
    _, res = run_recipe("web_drift_report", threshold=0.25)
    assert res["ok"] is True, res
    assert res["threshold"] == 0.25, res
    assert isinstance(res["verdict"], str) and res["verdict"], res


# ── web_render_page ─────────────────────────────────────────────────
def t_render():
    _, res = run_recipe("web_render_page", url="https://example.com")
    assert res["ok"] is True, res
    assert res["url"] == "https://example.com" and res["length"] >= 0, res


def t_render_bad_url():
    _, res = run_recipe("web_render_page", url="nie-url")
    assert res["ok"] is False and "http" in res["error"], res


# ── launch: kontrakt przepisów ──────────────────────────────────────
def t_all_recipes_discoverable():
    names = sorted(p.stem for p in RECIPES.glob("*.py"))
    assert names == ["web_drift_report", "web_render_page", "web_search_brief", "web_verify_links"], names


for fn in [
    t_brief, t_brief_no_query,
    t_verify, t_verify_bad_args, t_verify_empty, t_verify_skips_non_http,
    t_drift,
    t_render, t_render_bad_url,
    t_all_recipes_discoverable,
]:
    check(fn.__name__, fn)

print(f"\n  przepisy: {len(PASSED)} pass, {len(FAILED)} fail")
sys.exit(1 if FAILED else 0)
