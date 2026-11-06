#!/usr/bin/env python3
"""
test_sessions.py — trwałe sesje (WORKSPACE) + launcher end-to-end (offline).

Uruchomienie: python src/sandbox/test_sessions.py
Bez sieci: sesje testujemy kodem, który nie woła silnika; launcher przez CLI.
"""
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

SANDBOX = Path(__file__).resolve().parent
ROOT = SANDBOX.parents[1]

from sessions import load_workspace, save_workspace, close_session, list_sessions, session_file, _gc  # noqa: E402

PASSED, FAILED = [], []


def check(name, fn):
    try:
        fn()
        PASSED.append(name)
        print(f"[PASS] {name}")
    except AssertionError:
        FAILED.append(name)
        print(f"[FAIL] {name}\n{fn.__name__} -- patrz traceback w raporcie")
        import traceback
        traceback.print_exc()
    except Exception:
        FAILED.append(name)
        print(f"[ERROR] {name}")
        import traceback
        traceback.print_exc()


def t_workspace_roundtrip():
    save_workspace("test-s1", {"a": 1, "b": ["x"]})
    ws = load_workspace("test-s1")
    assert ws == {"a": 1, "b": ["x"]}, ws


def t_workspace_merge_semantics():
    save_workspace("test-s2", {"first": True})
    save_workspace("test-s2", {"second": True})
    ws = load_workspace("test-s2")
    assert ws == {"second": True}, ws  # zapis nadpisuje (model dostaje świeży workspace)
    close_session("test-s2")


def t_ttl_expires():
    f = session_file("test-ttl")
    save_workspace("test-ttl", {"old": True})
    # cofnij mtime poza TTL
    old = time.time() - 16 * 60
    import os
    os.utime(f, (old, old))
    _gc()
    ws = load_workspace("test-ttl")
    assert ws == {}, f"wygaszona sesja powinna być pusta, jest {ws}"


def t_close():
    save_workspace("test-close", {})
    assert close_session("test-close") is True
    assert close_session("test-close") is False
    assert "test-close" not in list_sessions()


def t_launch_dry_run():
    p = subprocess.run(
        [sys.executable, str(SANDBOX / "launch.py"), "--recipe", "web_search_brief", "--dry-run"],
        capture_output=True, text=True, cwd=str(ROOT),
    )
    out = json.loads(p.stdout)
    assert out["ok"] is True and out["dry_run"] is True and out["parsed"] is True, out
    assert "web.search" in out["allowed"], out
    assert p.returncode == 0


def t_launch_unknown_recipe():
    p = subprocess.run(
        [sys.executable, str(SANDBOX / "launch.py"), "--recipe", "nie-ma-takiego"],
        capture_output=True, text=True, cwd=str(ROOT),
    )
    out = json.loads(p.stdout)
    assert out["ok"] is False and "nie istnieje" in out["error"], out
    assert p.returncode == 2


def t_launch_code_with_session():
    code = "WORKSPACE['count'] = WORKSPACE.get('count', 0) + 1\nRESULT = {'ok': True, 'count': WORKSPACE['count']}"
    for expect in (1, 2):
        p = subprocess.run(
            [sys.executable, str(SANDBOX / "launch.py"), "--code", code,
             "--workspace", "--session", "test-counter"],
            capture_output=True, text=True, cwd=str(ROOT),
        )
        out = json.loads(p.stdout)
        assert out["ok"] is True, out
        assert out["result"]["count"] == expect, (out, expect)
        assert out["telemetry"]["session"] == "test-counter", out
    close_session("test-counter")


def t_launch_bad_args_json():
    p = subprocess.run(
        [sys.executable, str(SANDBOX / "launch.py"), "--recipe", "web_search_brief",
         "--args", "nie json"],
        capture_output=True, text=True, cwd=str(ROOT),
    )
    out = json.loads(p.stdout)
    assert out["ok"] is False and "JSON" in out["error"], out


def t_launch_code_crash_isolated():
    p = subprocess.run(
        [sys.executable, str(SANDBOX / "launch.py"), "--code", "1/0"],
        capture_output=True, text=True, cwd=str(ROOT),
    )
    out = json.loads(p.stdout)
    assert out["ok"] is False and "ZeroDivisionError" in out["error"], out
    assert p.returncode == 4


def t_allowlist_blocks():
    # W czystym repo sandbox wystawia TYLKO przestrzeń web: 'posts' po prostu
    # nie istnieje — izolacja przez konstrukcję globals, nie przez allowlistę.
    p = subprocess.run(
        [sys.executable, str(SANDBOX / "launch.py"),
         "--code", "posts.list()\nRESULT = {'ok': True}"],
        capture_output=True, text=True, cwd=str(ROOT),
    )
    out = json.loads(p.stdout)
    assert out["ok"] is False and "NameError" in out["error"], out


for fn in [
    t_workspace_roundtrip, t_workspace_merge_semantics, t_ttl_expires, t_close,
    t_launch_dry_run, t_launch_unknown_recipe, t_launch_code_with_session,
    t_launch_bad_args_json, t_launch_code_crash_isolated, t_allowlist_blocks,
]:
    check(fn.__name__, fn)

print(f"\n  sesje/launcher: {len(PASSED)} pass, {len(FAILED)} fail")
sys.exit(1 if FAILED else 0)
