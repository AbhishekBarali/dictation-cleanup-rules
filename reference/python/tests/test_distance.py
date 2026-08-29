"""Tests for the four string metrics in _distance.py.

AGENTS.md asks that hand-written metrics come with their own tests, because a
quietly wrong distance function turns into a quietly wrong stage.
"""

from __future__ import annotations

import pytest

from _distance import (
    damerau_levenshtein,
    levenshtein,
    normalized_damerau_levenshtein,
    soundex,
)


@pytest.mark.parametrize(
    ("first", "second", "expected"),
    [
        ("", "", 0),
        ("abc", "", 3),
        ("", "abc", 3),
        ("abc", "abc", 0),
        ("helo", "hello", 1),
        ("kitten", "sitting", 3),
        # A transposition costs 2 here, which is the whole reason stage 4 uses
        # Damerau-Levenshtein instead.
        ("wrold", "world", 2),
    ],
)
def test_levenshtein(first, second, expected):
    assert levenshtein(first, second) == expected
    assert levenshtein(second, first) == expected


@pytest.mark.parametrize(
    ("first", "second", "expected"),
    [
        ("", "", 0),
        ("abc", "abc", 0),
        ("rokcet", "rocket", 1),  # one transposition
        ("emogi", "emoji", 1),  # one substitution
        ("thumps up", "thumbs up", 1),
        ("ca", "abc", 2),  # unrestricted: transpose then insert
    ],
)
def test_damerau_levenshtein(first, second, expected):
    assert damerau_levenshtein(first, second) == expected
    assert damerau_levenshtein(second, first) == expected


def test_normalized_damerau_levenshtein():
    assert normalized_damerau_levenshtein("", "") == 1.0
    assert normalized_damerau_levenshtein("abc", "abc") == 1.0
    assert normalized_damerau_levenshtein("abc", "xyz") == 0.0
    # One edit out of six characters.
    assert normalized_damerau_levenshtein("rokcet", "rocket") == pytest.approx(1 - 1 / 6)


@pytest.mark.parametrize(
    ("word", "expected"),
    [
        ("", ""),
        ("hello", "h400"),
        ("helo", "h400"),
        ("world", "w643"),
        ("wrold", "w643"),
        ("rand", "r530"),
        ("randd", "r530"),  # adjacent equal codes collapse
        ("chargebee", "c621"),
        # The first character is carried through literally rather than coded,
        # which is where this differs from textbook Soundex. Textbook gives
        # P236 and S000 for these two.
        ("pfister", "p123"),
        ("sc", "s200"),
    ],
)
def test_soundex(word, expected):
    assert soundex(word) == expected


def test_soundex_pairs_used_by_stage_one():
    """The pairs stage 1 relies on, and one it must not merge."""
    assert soundex("helo") == soundex("hello")
    assert soundex("randd") == soundex("rand")
    assert soundex("rd") != soundex("rand")
