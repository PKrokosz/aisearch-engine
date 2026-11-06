#!/usr/bin/env python3
"""
sandbox/sessions.py — trwałe sesje przepisów (WORKSPACE + historia).

Model woła narzędzie wielokrotnie w ramach jednego łańcucha rozumowania.
Sesja przechowuje WORKSPACE (dict JSON-serializable) między wywołaniami:
  .cache/runtime/<session>/workspace.json
TTL 15 min, max 50 sesji (najstarsza wypada). session_hash jest stałym
korzeniem telemetrycznym łączącym wywołania w jeden łańcuch.
Bez zależności, offline, deterministyczne.
"""
from __future__ import annotations

import json
import time
from pathlib import Path

TTL_MS = 15 * 60 * 1000
MAX_SESSIONS = 50


def _sessions_dir() -> Path:
    root = Path(__file__).resolve().parents[2]
    return root / ".cache" / "runtime"


def _session_file(session_id: str) -> Path:
    return _sessions_dir() / session_id / "workspace.json"


def _gc() -> None:
    """Wyrzuć wygasłe i najstarsze poza limitem."""
    base = _sessions_dir()
    if not base.exists():
        return
    entries = []
    for d in base.iterdir():
        if not d.is_dir():
            continue
        try:
            mtime = (d / "workspace.json").stat().st_mtime
        except OSError:
            continue
        entries.append((mtime, d))
    now = time.time()
    for mtime, d in sorted(entries):
        if (now - mtime) * 1000 > TTL_MS:
            (d / "workspace.json").unlink(missing_ok=True)
            d.rmdir()
    alive = [(p.stat().st_mtime if (p := (d / "workspace.json")).exists() else 0, d) for _, d in entries]
    alive = [(m, d) for m, d in alive if (d / "workspace.json").exists()]
    while len(alive) > MAX_SESSIONS:
        alive.sort(key=lambda x: x[0])
        _, d = alive.pop(0)
        (d / "workspace.json").unlink(missing_ok=True)
        d.rmdir()


def session_file(session_id: str) -> Path:
    return _session_file(session_id)


def load_workspace(session_id: str) -> dict:
    _gc()
    f = _session_file(session_id)
    if not f.exists():
        return {}
    try:
        data = json.loads(f.read_text(encoding="utf-8"))
        return data.get("workspace", {}) if isinstance(data, dict) else {}
    except (json.JSONDecodeError, OSError):
        return {}


def save_workspace(session_id: str, workspace: dict, history_entry: dict | None = None) -> dict:
    base = _sessions_dir() / session_id
    base.mkdir(parents=True, exist_ok=True)
    payload = {"session": session_id, "updatedAt": int(time.time() * 1000), "workspace": workspace}
    if history_entry is not None:
        hist_file = base / "history.jsonl"
        with hist_file.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(history_entry, ensure_ascii=False) + "\n")
    (base / "workspace.json").write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
    return payload


def close_session(session_id: str) -> bool:
    f = _session_file(session_id)
    if f.exists():
        f.unlink()
        return True
    return False


def list_sessions() -> list:
    base = _sessions_dir()
    if not base.exists():
        return []
    out = []
    for d in sorted(base.iterdir()):
        if d.is_dir() and (d / "workspace.json").exists():
            out.append(d.name)
    return out
