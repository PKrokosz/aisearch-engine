#!/usr/bin/env python3
"""
sandbox/launch.py — launcher przepisów (proces izolowany, `python -I`).

Kontrakt (stabilny):
  python src/sandbox/launch.py --recipe web_search_brief --args '{"query":"..."}'
  python src/sandbox/launch.py --code 'RESULT = web.stats()' --dry-run
  python src/sandbox/launch.py --recipe web_verify_links --args '...' --workspace --session s1

Wyjście: JEDEN obiekt JSON na stdout {ok, result, telemetry}.
Globals dla kodu: web (przestrzeń silnika), shim, RESULT, WORKSPACE, HISTORY.
Bezpieczeństwo: allowlista (client.py), budżet wywołań, redakcja (redact.py),
tryb dry-run nie dotyka sieci.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from client import make_shim, BudgetExceeded, NotAllowed, ALLOWED  # noqa: E402
from redact import redact  # noqa: E402
from sessions import load_workspace, save_workspace, close_session, list_sessions  # noqa: E402

RECIPES_DIR = Path(__file__).resolve().parent / "recipes"


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="aisearch sandbox launcher")
    p.add_argument("--code", help="kod python do wykonania (zamiast --recipe)")
    p.add_argument("--recipe", help="nazwa przepisu z recipes/")
    p.add_argument("--args", default="{}", help="JSON z argumentami przepisu (globals)")
    p.add_argument("--dry-run", action="store_true", help="tylko plan wywołań, bez sieci")
    p.add_argument("--workspace", action="store_true", help="włącz trwały WORKSPACE (sesja)")
    p.add_argument("--session", default="", help="id sesji (z --workspace)")
    p.add_argument("--close-session", action="store_true", help="zamknij sesję i wyjdź")
    p.add_argument("--list-sessions", action="store_true", help="lista sesji i wyjdź")
    p.add_argument("--max-calls", type=int, default=25)
    p.add_argument("--timeout", type=float, default=30.0)
    p.add_argument("--api-url", default="")
    return p


def main() -> int:
    args = build_parser().parse_args()
    out = print

    if args.list_sessions:
        out(json.dumps({"ok": True, "sessions": list_sessions()}, ensure_ascii=False))
        return 0
    if args.close_session:
        if not args.session:
            out(json.dumps({"ok": False, "error": "--close-session wymaga --session"}, ensure_ascii=False))
            return 2
        out(json.dumps({"ok": True, "closed": close_session(args.session)}, ensure_ascii=False))
        return 0

    started = time.perf_counter()
    workspace: dict = load_workspace(args.session) if (args.workspace and args.session) else {}

    shim = make_shim(base_url=args.api_url or None, max_calls=args.max_calls, timeout=args.timeout)

    if args.recipe:
        recipe_path = RECIPES_DIR / f"{args.recipe}.py"
        if not recipe_path.exists():
            out(json.dumps({"ok": False, "error": f"przepis nie istnieje: {args.recipe}"}, ensure_ascii=False))
            return 2
        code = recipe_path.read_text(encoding="utf-8")
        try:
            recipe_args = json.loads(args.args)
        except json.JSONDecodeError:
            out(json.dumps({"ok": False, "error": "--args nie jest poprawnym JSON"}, ensure_ascii=False))
            return 2
    elif args.code:
        code = args.code
        recipe_args = json.loads(args.args)
    else:
        out(json.dumps({"ok": False, "error": "wymagane --code albo --recipe"}, ensure_ascii=False))
        return 2

    globals_dict = {
        "web": shim.web,
        "shim": shim,
        "RESULT": None,
        "WORKSPACE": workspace,
        "HISTORY": [],
    }
    for k, v in recipe_args.items():
        globals_dict[k] = v

    if args.dry_run:
        # Plan bez sieci: crash-test kodu (parsowanie) + lista dozwolonnych narzędzi.
        try:
            compile(code, "<recipe>", "exec")
        except SyntaxError as e:
            out(json.dumps({"ok": False, "error": f"błąd składni przepisu: {e}"}, ensure_ascii=False))
            return 2
        out(json.dumps({
            "ok": True, "dry_run": True, "recipe": args.recipe, "parsed": True,
            "allowed": sorted(ALLOWED),
            "maxCalls": args.max_calls,
        }, ensure_ascii=False))
        return 0

    try:
        exec(code, globals_dict)
        result = globals_dict.get("RESULT")
        ms = int((time.perf_counter() - started) * 1000)
        if args.workspace and args.session:
            save_workspace(args.session, globals_dict["WORKSPACE"], {"result": str(result)[:200], "calls": shim.calls, "ms": ms})
        out(json.dumps({
            "ok": True,
            "result": redact(result if result is not None else {}),
            "telemetry": {"calls": shim.calls, "ms": ms, "session": args.session or None, "dryRun": False},
        }, ensure_ascii=False))
        return 0
    except (NotAllowed, BudgetExceeded) as e:
        out(json.dumps({"ok": False, "error": str(e), "phase": "allowlist/budget"}, ensure_ascii=False))
        return 3
    except Exception as e:  # przepis padł — proces izolowany, rodzic żyje
        out(json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}", "calls": shim.calls}, ensure_ascii=False))
        return 4


if __name__ == "__main__":
    sys.exit(main())
