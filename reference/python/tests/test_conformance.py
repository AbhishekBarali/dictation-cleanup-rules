"""Runs conformance/cases.json against the reference implementation.

Every case is a fixed input/output pair taken from the original Rust test
suite. Each stage runs in isolation, never as a pipeline, and each case becomes
one test named after its id so a failure names the behaviour that broke.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from _distance import soundex
from cleanup import (
    apply_replacements,
    apply_vocabulary,
    expand_spoken_emoji,
    extract_punctuation,
    filter_transcript,
    preserve_case_pattern,
)

CASES_PATH = Path(__file__).resolve().parents[3] / "conformance" / "cases.json"

with CASES_PATH.open(encoding="utf-8") as handle:
    SUITE = json.load(handle)


def _run_case(stage_name: str, stage: dict, case: dict) -> str:
    """Call the one function this stage covers and return its output."""
    if stage_name == "soundex":
        return soundex(case["word"])

    if stage_name == "vocabulary":
        return apply_vocabulary(case["text"], case["vocabulary"], case["threshold"])

    if stage_name == "case_preservation":
        return preserve_case_pattern(case["original"], case["replacement"])

    if stage_name == "punctuation_split":
        return list(extract_punctuation(case["word"]))

    if stage_name == "filler_and_stutter":
        return filter_transcript(
            case["text"], case["lang"], case["custom_filler_words"]
        )

    if stage_name == "spoken_emoji":
        return expand_spoken_emoji(case["text"])

    if stage_name == "replacements":
        # Absent fields take the defaults the case file declares, which is what
        # a real caller's rule editor would supply.
        defaults = stage.get("rule_defaults", {})
        rules = [{**defaults, **rule} for rule in case["rules"]]
        return apply_replacements(case["text"], rules)

    raise AssertionError(f"unknown stage: {stage_name}")


def _collect_cases() -> list[tuple[str, dict, dict]]:
    collected = []
    for stage_name, stage in SUITE["stages"].items():
        for case in stage["cases"]:
            collected.append((stage_name, stage, case))
    return collected


ALL_CASES = _collect_cases()


@pytest.mark.parametrize(
    ("stage_name", "stage", "case"),
    ALL_CASES,
    ids=[case["id"] for _, _, case in ALL_CASES],
)
def test_conformance_case(stage_name: str, stage: dict, case: dict) -> None:
    actual = _run_case(stage_name, stage, case)

    asserted_something = False

    if "expected" in case:
        assert actual == case["expected"]
        asserted_something = True

    for fragment in case.get("expected_contains", []):
        assert fragment in actual, f"missing {fragment!r} in {actual!r}"
        asserted_something = True

    for fragment in case.get("expected_not_contains", []):
        assert fragment not in actual, f"unexpected {fragment!r} in {actual!r}"
        asserted_something = True

    if "expected_matches" in case:
        assert re.search(case["expected_matches"], actual), (
            f"{actual!r} does not match {case['expected_matches']!r}"
        )
        asserted_something = True

    assert asserted_something, f"case {case['id']} asserts nothing"


def test_every_case_in_the_file_is_covered() -> None:
    """Guards against a stage being added to the file and skipped here."""
    total = sum(len(stage["cases"]) for stage in SUITE["stages"].values())
    assert len(ALL_CASES) == total
