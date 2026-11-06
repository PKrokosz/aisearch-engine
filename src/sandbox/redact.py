#!/usr/bin/env python3
"""
sandbox/redact.py — redakcja sekretów na wyjściu sandboxu.

Zasada: model nie widzi wartości, które wyglądają na sekret (klucze API,
tokeny, Bearery), nawet jeśli źle skonfigurowany serwer je zwróci.
Proste, deterministyczne, bez zależności.
"""
from __future__ import annotations

import re

_PATTERNS = [
    (re.compile(r"(?i)(authorization\s*[:=]\s*)(bearer\s+)?([A-Za-z0-9._\-]{12,})"), r"\1\2[REDACTED]"),
    (re.compile(r"(?i)\b(api[_-]?key|token|secret|password|passwd)\b(\s*[:=]\s*)([\"']?)([^\s\"',}]{8,})([\"']?)"), r"\1\2\3[REDACTED]\5"),
    (re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b"), "[EMAIL]"),
]


def redact_value(v):
    if isinstance(v, str):
        out = v
        for pat, sub in _PATTERNS:
            out = pat.sub(sub, out)
        return out
    if isinstance(v, dict):
        return {k: redact_value(x) for k, x in v.items()}
    if isinstance(v, list):
        return [redact_value(x) for x in v]
    return v


def redact(payload):
    return redact_value(payload)
