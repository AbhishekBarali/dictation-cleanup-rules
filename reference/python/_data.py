"""Loads the two pattern tables that ship with the repository.

The tables live in `data/` at the repository root, not inside this package, so
that a port in another language reads the same bytes rather than a copy that can
drift. Paths resolve from `__file__` and never from the working directory, so
importing this module works from anywhere.
"""

from __future__ import annotations

import json
from pathlib import Path

__all__ = ["DATA_DIR", "REPO_ROOT", "filler_words_for_language", "emoji_aliases"]

# _data.py -> python -> reference -> repository root
REPO_ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = REPO_ROOT / "data"

_FILLER_WORDS_PATH = DATA_DIR / "filler_words.json"
_EMOJI_ALIASES_PATH = DATA_DIR / "emoji_aliases.json"

_filler_words_cache: dict[str, list[str]] | None = None
_emoji_aliases_cache: list[tuple[str, str]] | None = None


def _load_filler_words() -> dict[str, list[str]]:
    global _filler_words_cache
    if _filler_words_cache is None:
        with _FILLER_WORDS_PATH.open(encoding="utf-8") as handle:
            _filler_words_cache = json.load(handle)
    return _filler_words_cache


def filler_words_for_language(lang: str) -> list[str]:
    """Built-in filler list for a language code.

    The code is cut at the first "-" or "_", so "pt-BR" resolves as "pt". An
    unknown code falls back to the "*" entry, which deliberately omits "um",
    "eh" and "ha" because each of those is a real word in a language the table
    covers. The per-language lists are not translations of each other.
    """
    table = _load_filler_words()
    base_lang = lang.replace("_", "-").split("-", 1)[0]
    return table.get(base_lang, table["*"])


def emoji_aliases() -> list[tuple[str, str]]:
    """Alias table as (phrase, symbol) pairs, in file order.

    Order is part of the contract: stage 4's fuzzy pass keeps the earliest
    candidate when two aliases score identically.
    """
    global _emoji_aliases_cache
    if _emoji_aliases_cache is None:
        with _EMOJI_ALIASES_PATH.open(encoding="utf-8") as handle:
            entries = json.load(handle)
        _emoji_aliases_cache = [(entry["phrase"], entry["symbol"]) for entry in entries]
    return _emoji_aliases_cache
