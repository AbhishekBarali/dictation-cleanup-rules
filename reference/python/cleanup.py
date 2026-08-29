"""The four deterministic dictation cleanup stages.

This file is written to be read and ported, not to be fast. Variable names are
spelled out, the algorithms follow `spec/SPEC.md` step by step, and comments
appear only where the specified behaviour is not obvious from the code.

Pipeline order is normative:

    1. apply_vocabulary       pre-model
    2. filter_transcript      pre-model
    3. (a language model, not in this file, allowed to fail)
    4. expand_spoken_emoji    post-model
    5. apply_replacements     post-model, final authority

Every function here is a pure function of (text, config). No network, no
randomness, no model. The one clock read in the whole pipeline is stage 5's
`[date]` and `[time]` tokens.
"""

from __future__ import annotations

import dataclasses
import datetime as _datetime
import re
from typing import Any, Iterable, Mapping, Sequence

from _data import emoji_aliases, filler_words_for_language
from _distance import (
    damerau_levenshtein,
    levenshtein,
    normalized_damerau_levenshtein,
    soundex,
)

__all__ = [
    "ReplacementRule",
    "apply_vocabulary",
    "filter_transcript",
    "expand_spoken_emoji",
    "apply_replacements",
    "preserve_case_pattern",
    "extract_punctuation",
]


# --------------------------------------------------------------------------
# Shared helpers
# --------------------------------------------------------------------------


def build_match_key(word: str) -> str:
    """Reduce a word to lowercase alphanumeric characters, dropping the rest.

    Both sides of a stage 1 comparison go through this, which is what lets
    "Charge B" line up with "ChargeBee" and "R&D" with "rd".
    """
    return "".join(character.lower() for character in word if character.isalnum())


def preserve_case_pattern(original: str, replacement: str) -> str:
    """Re-case a vocabulary spelling to match how the speaker's word arrived.

    The middle branch only touches the first character, so a transcript reading
    "Chargebee" still produces "ChargeBee" rather than "Chargebee". Stage 1
    substitutes; it does not rewrite the vocabulary entry.
    """
    if all(character.isupper() for character in original):
        return replacement.upper()
    if original[:1].isupper():
        return replacement[:1].upper() + replacement[1:]
    return replacement


def extract_punctuation(word: str) -> tuple[str, str]:
    """Split a word into (leading punctuation, trailing punctuation).

    The runs are non-alphanumeric only. That boundary matters: the match key
    already dropped punctuation but kept digits, so for "GPT4" the trailing "4"
    belongs to the key and not to the suffix. Treating it as a suffix would
    re-append it and turn "GPT-4" into "GPT-44".
    """
    prefix_length = 0
    while prefix_length < len(word) and not word[prefix_length].isalnum():
        prefix_length += 1

    # Counted independently of the prefix, so a word with no alphanumerics at
    # all reports its whole self as both runs. That is what the spec says and
    # what the original does.
    suffix_length = 0
    while suffix_length < len(word) and not word[len(word) - 1 - suffix_length].isalnum():
        suffix_length += 1

    prefix = word[:prefix_length]
    suffix = word[len(word) - suffix_length :] if suffix_length else ""
    return prefix, suffix


# --------------------------------------------------------------------------
# Stage 1: vocabulary correction
# --------------------------------------------------------------------------

MAX_VOCABULARY_NGRAM_WORDS = 3
MAX_CANDIDATE_LENGTH = 50


@dataclasses.dataclass(frozen=True)
class _VocabularyKey:
    """One comparison key plus the index of the entry it came from."""

    entry_index: int
    key: str


def _build_vocabulary_keys(entry: str, entry_index: int) -> list[_VocabularyKey]:
    """Comparison keys for one vocabulary entry.

    An entry containing "&" gets a second key with "&" spelled out, so "R&D"
    matches both the compact transcription "RD" and the spoken "R and D".
    """
    keys: list[_VocabularyKey] = []

    primary_key = build_match_key(entry)
    if primary_key:
        keys.append(_VocabularyKey(entry_index, primary_key))

    if "&" in entry:
        expanded_key = build_match_key(entry.replace("&", " and "))
        if expanded_key and expanded_key != primary_key:
            keys.append(_VocabularyKey(entry_index, expanded_key))

    return keys


def _score_candidate(candidate_key: str, vocabulary_key: str) -> float | None:
    """Distance score for one candidate against one vocabulary key.

    Lower is better. Returns None when the pair is rejected outright.
    """
    longest = max(len(candidate_key), len(vocabulary_key))

    # Length gate. Without it a long n-gram swallows a short entry, so
    # "openaigpt" would match "openai" and eat the following word. The 2.0
    # floor keeps short entries reachable at all.
    length_difference = abs(len(candidate_key) - len(vocabulary_key))
    if length_difference > max(longest * 0.25, 2.0):
        return None

    spelling_score = levenshtein(candidate_key, vocabulary_key) / longest if longest else 1.0

    # A phonetic hit tolerates roughly three times the spelling distance,
    # because dictation errors are heard rather than typed.
    if soundex(candidate_key) == soundex(vocabulary_key):
        return spelling_score * 0.3
    return spelling_score


def _find_best_entry(
    candidate_key: str,
    vocabulary: Sequence[str],
    vocabulary_keys: Sequence[_VocabularyKey],
    threshold: float,
) -> str | None:
    """Best vocabulary entry for a candidate n-gram key, or None."""
    if not candidate_key or len(candidate_key) > MAX_CANDIDATE_LENGTH:
        return None

    best_entry: str | None = None
    best_score = float("inf")

    for vocabulary_key in vocabulary_keys:
        score = _score_candidate(candidate_key, vocabulary_key.key)
        if score is None:
            continue
        # Strictly better, so a tie keeps the earlier vocabulary entry.
        if score < threshold and score < best_score:
            best_entry = vocabulary[vocabulary_key.entry_index]
            best_score = score

    return best_entry


def apply_vocabulary(
    text: str,
    vocabulary: Sequence[str],
    threshold: float = 0.18,
) -> str:
    """Stage 1. Recover proper nouns and jargon the recogniser flattened.

    Why this runs before the model: a table lookup that fixes "Charge B" into
    "ChargeBee" is faster and more predictable than asking a model to guess the
    speaker's employer. It also handles the case where one written word arrives
    as several spoken ones, which is the reason for the n-gram scan.

    Skip this stage entirely if your recogniser accepts a bias or hot-word
    prompt. Biasing the decoder beats correcting after the fact, and doing both
    double-corrects.

    `threshold` is a distance ceiling; lower is stricter.
    """
    if not vocabulary:
        return text

    vocabulary_keys = [
        key
        for entry_index, entry in enumerate(vocabulary)
        for key in _build_vocabulary_keys(entry, entry_index)
    ]

    words = text.split()
    corrected_words: list[str] = []
    word_index = 0

    while word_index < len(words):
        matched = False

        # Longest n-gram first, so "Open AI GPT" prefers OpenAI over GPT.
        for ngram_length in range(MAX_VOCABULARY_NGRAM_WORDS, 0, -1):
            if word_index + ngram_length > len(words):
                continue

            ngram_words = words[word_index : word_index + ngram_length]
            candidate_key = "".join(build_match_key(word) for word in ngram_words)

            entry = _find_best_entry(
                candidate_key, vocabulary, vocabulary_keys, threshold
            )
            if entry is None:
                continue

            prefix, _ = extract_punctuation(ngram_words[0])
            _, suffix = extract_punctuation(ngram_words[-1])
            cased_entry = preserve_case_pattern(ngram_words[0], entry)

            corrected_words.append(prefix + cased_entry + suffix)
            word_index += ngram_length
            matched = True
            break

        if not matched:
            corrected_words.append(words[word_index])
            word_index += 1

    return " ".join(corrected_words)


# --------------------------------------------------------------------------
# Stage 2: filler and stutter filter
# --------------------------------------------------------------------------

STUTTER_THRESHOLD = 3
_MULTIPLE_WHITESPACE = re.compile(r"\s{2,}")


def _remove_filler_words(text: str, filler_words: Iterable[str]) -> str:
    """Delete each filler word, in list order, with an optional trailing , or .

    Consuming that trailing punctuation is what turns "Well, uhm, I think" into
    "Well, I think" instead of leaving an orphan comma behind. Each word is
    regex escaped, so a filler list is data and never a pattern.
    """
    filtered = text
    for filler_word in filler_words:
        pattern = re.compile(r"\b" + re.escape(filler_word) + r"\b[,.]?", re.IGNORECASE)
        filtered = pattern.sub("", filtered)
    return filtered


def _collapse_stutters(text: str) -> str:
    """Collapse a run of 3 or more identical words to the first occurrence.

    Three and not two: "no no is fine" is a real sentence and "very very good"
    is emphasis. Keeping the first occurrence preserves its casing, so
    "No NO no NO no" becomes "No". Only all-alphabetic words are eligible,
    which is what lets "1 1 1" and "-- -- --" survive untouched.
    """
    words = text.split()
    if not words:
        return text

    kept_words: list[str] = []
    word_index = 0

    while word_index < len(words):
        word = words[word_index]
        lowered = word.lower()

        if lowered.isalpha():
            run_length = 1
            while (
                word_index + run_length < len(words)
                and words[word_index + run_length].lower() == lowered
            ):
                run_length += 1

            kept_words.append(word)
            word_index += run_length if run_length >= STUTTER_THRESHOLD else 1
        else:
            kept_words.append(word)
            word_index += 1

    return " ".join(kept_words)


def filter_transcript(
    text: str,
    lang: str = "en",
    custom_filler_words: Sequence[str] | None = None,
) -> str:
    """Stage 2. Remove hesitation sounds and repetition artefacts.

    Why this runs before the model: it is the pass most people mean by
    "cleanup" and it needs no model at all. Deleting "um" from a table cannot
    reword the sentence around it; a model sometimes does.

    `custom_filler_words` is three-valued and the distinction matters:

    - None means use the built-in list for `lang`.
    - A non-empty list means use that list instead of the built-in one.
    - An empty list means filtering is off.

    A single truthiness check collapses the last two cases and silently
    disables the pass, so the test below is `is None` on purpose.

    This stage only deletes. It never adds, reorders or re-cases a word it is
    keeping, and it has no notion of a sentence.
    """
    if custom_filler_words is None:
        filler_words = filler_words_for_language(lang)
    else:
        filler_words = list(custom_filler_words)

    filtered = _remove_filler_words(text, filler_words)
    filtered = _collapse_stutters(filtered)
    # Whitespace tidying comes last, because filler removal leaves double
    # spaces wherever it deleted a word.
    filtered = _MULTIPLE_WHITESPACE.sub(" ", filtered)
    return filtered.strip()


# --------------------------------------------------------------------------
# Stage 4: spoken emoji expansion
# --------------------------------------------------------------------------

MAX_ALIAS_WORDS = 5
EMOJI_KEYWORD = "emoji"
FUZZY_MINIMUM_COMPACT_LENGTH = 5
FUZZY_MINIMUM_SIMILARITY = 0.80
FUZZY_AMBIGUITY_MARGIN = 0.08

# Letters and digits, optionally joined by an apostrophe. `[^\W_]` is the
# stdlib spelling of "word character but not underscore", and it is Unicode
# aware for str patterns.
_WORD_PATTERN = re.compile(r"[^\W_]+(?:['\u2019][^\W_]+)*")

_SOFT_SEPARATOR_CHARACTERS = ("-", ",")


@dataclasses.dataclass(frozen=True)
class _Token:
    start: int
    end: int
    text: str


def _is_emoji_keyword(word: str) -> bool:
    """True when a word is close enough to "emoji" to end a command.

    The keyword is mandatory, and that single constraint is what makes the
    stage safe: without it every occurrence of "fire" or "happy" becomes a
    candidate. The 4 to 7 length window is what stops "emojiology" matching.
    """
    lowered = word.lower()
    return 4 <= len(lowered) <= 7 and damerau_levenshtein(lowered, EMOJI_KEYWORD) <= 1


def _has_soft_separators(text: str, tokens: Sequence[_Token]) -> bool:
    """True when only whitespace, "-" or "," sits between adjacent tokens.

    This admits "thumbs-up emoji" and "HAPPY, EMOJI" while blocking
    "I feel happy. Emoji are useful." A sentence-ending period is a hard
    boundary and no window may cross it.
    """
    for earlier, later in zip(tokens, tokens[1:]):
        gap = text[earlier.end : later.start]
        if not all(
            character.isspace() or character in _SOFT_SEPARATOR_CHARACTERS
            for character in gap
        ):
            return False
    return True


def _normalized_phrase(tokens: Sequence[_Token]) -> str:
    """Lowercase the window and join it with single spaces, as the table is."""
    return " ".join(token.text.lower() for token in tokens)


def _find_alias_before(
    text: str,
    tokens: Sequence[_Token],
    keyword_index: int,
    copied_until: int,
) -> tuple[int, str] | None:
    """Look backwards from a keyword for an alias phrase.

    Returns (start offset of the alias, symbol) or None. The two passes are
    deliberately different loops: exact goes longest window first, fuzzy goes
    shortest first.
    """
    if keyword_index == 0:
        return None

    aliases = emoji_aliases()
    max_window = min(keyword_index, MAX_ALIAS_WORDS)

    def window_is_usable(start_index: int) -> bool:
        if tokens[start_index].start < copied_until:
            return False  # already consumed by an earlier replacement
        return _has_soft_separators(text, tokens[start_index : keyword_index + 1])

    # Exact pass, longest window first. Longest first is what makes
    # "red heart emoji" produce the red heart rather than matching the
    # "heart" suffix.
    for window_length in range(max_window, 0, -1):
        start_index = keyword_index - window_length
        if not window_is_usable(start_index):
            continue
        candidate = _normalized_phrase(tokens[start_index:keyword_index])
        for phrase, symbol in aliases:
            if phrase == candidate:
                return tokens[start_index].start, symbol

    # Fuzzy pass, shortest window first, and only when nothing matched exactly.
    best: tuple[int, str, float] | None = None
    runner_up_score = 0.0

    for window_length in range(1, max_window + 1):
        start_index = keyword_index - window_length
        if not window_is_usable(start_index):
            continue

        candidate = _normalized_phrase(tokens[start_index:keyword_index])
        compact_length = sum(1 for character in candidate if not character.isspace())
        # Short words are too easy to confuse, which is why "bad emoji" stays
        # as written rather than becoming a crying face.
        if compact_length < FUZZY_MINIMUM_COMPACT_LENGTH:
            continue

        max_edits = 2 if compact_length >= 12 else 1

        for phrase, symbol in aliases:
            if len(phrase.split()) != window_length:
                continue
            if damerau_levenshtein(candidate, phrase) > max_edits:
                continue
            score = normalized_damerau_levenshtein(candidate, phrase)
            if score < FUZZY_MINIMUM_SIMILARITY:
                continue

            if best is None:
                best = (start_index, symbol, score)
            elif symbol == best[1]:
                # Same symbol, so this is not a competing reading. Keep the
                # better score and leave the runner-up untouched.
                if score > best[2]:
                    best = (start_index, symbol, score)
            elif score > best[2]:
                runner_up_score = max(runner_up_score, best[2])
                best = (start_index, symbol, score)
            else:
                runner_up_score = max(runner_up_score, score)

    if best is None:
        return None

    # Ambiguity veto. A near-tie between two different symbols is not a match,
    # so change nothing rather than guess.
    start_index, symbol, score = best
    if runner_up_score != 0.0 and score - runner_up_score < FUZZY_AMBIGUITY_MARGIN:
        return None
    return tokens[start_index].start, symbol


def expand_spoken_emoji(text: str) -> str:
    """Stage 4. Turn "thumbs up emoji" into an emoji, and leave "fire" alone.

    Why this runs after the model: the user asked for the symbol and the model
    did not, so a table has to be able to overwrite whatever the model wrote.

    Off by default in a product. Everything outside a replaced span is copied
    through verbatim, so punctuation and spacing survive untouched, and when
    nothing matches the input string is returned as-is.
    """
    tokens = [
        _Token(match.start(), match.end(), match.group())
        for match in _WORD_PATTERN.finditer(text)
    ]

    pieces: list[str] = []
    copied_until = 0
    changed = False

    for keyword_index, token in enumerate(tokens):
        if token.start < copied_until or not _is_emoji_keyword(token.text):
            continue

        found = _find_alias_before(text, tokens, keyword_index, copied_until)
        if found is None:
            continue

        alias_start, symbol = found
        pieces.append(text[copied_until:alias_start])
        pieces.append(symbol)
        copied_until = token.end
        changed = True

    if not changed:
        return text

    pieces.append(text[copied_until:])
    return "".join(pieces)


# --------------------------------------------------------------------------
# Stage 5: user replacement rules
# --------------------------------------------------------------------------

RULE_DEFAULTS: Mapping[str, Any] = {
    "is_regex": False,
    "enabled": True,
    "trim_before": False,
    "trim_after": False,
    "capitalization": "none",
}


@dataclasses.dataclass
class ReplacementRule:
    """One find/replace rule. `apply_replacements` also accepts plain dicts."""

    search: str
    replace: str
    is_regex: bool = False
    enabled: bool = True
    trim_before: bool = False
    trim_after: bool = False
    capitalization: str = "none"


def _rule_field(rule: Any, name: str) -> Any:
    """Read one field from a dict or an object, falling back to the default."""
    if isinstance(rule, Mapping):
        value = rule.get(name, RULE_DEFAULTS.get(name))
    else:
        value = getattr(rule, name, RULE_DEFAULTS.get(name))
    return RULE_DEFAULTS.get(name) if value is None else value


def _capitalize_first(text: str) -> str:
    """Uppercase the first character and leave the rest alone.

    Not `str.capitalize`, which would lowercase the tail.
    """
    return text[:1].upper() + text[1:]


def expand_replacement(template: str, capitalization: str = "none") -> str:
    """Expand the magic tokens inside a rule's replacement template.

    Transform tokens act on the whole rule output regardless of where they
    appear, so they are detected and stripped before anything else. `[date]`
    and `[time]` are the only impurity in the pipeline; inject a clock here if
    you need byte-reproducible output.
    """
    working = template

    # 1. Detect and strip the transform tokens.
    wants_uppercase = "[uppercase]" in working or "[upper]" in working
    working = working.replace("[uppercase]", "").replace("[upper]", "")
    wants_lowercase = "[lowercase]" in working or "[lower]" in working
    working = working.replace("[lowercase]", "").replace("[lower]", "")
    wants_capitalize = "[capitalize]" in working
    working = working.replace("[capitalize]", "")
    wants_nospace = "[nospace]" in working
    working = working.replace("[nospace]", "")

    # 2. Expand the value-producing tokens.
    if "[date]" in working or "[time]" in working:
        now = _datetime.datetime.now()
        working = working.replace("[date]", now.strftime("%Y-%m-%d"))
        working = working.replace("[time]", now.strftime("%H:%M"))

    # 3. Apply the recorded transforms, in this order.
    if wants_lowercase:
        working = working.lower()
    if wants_uppercase:
        working = working.upper()
    if wants_capitalize:
        working = _capitalize_first(working)
    if wants_nospace:
        working = "".join(
            character for character in working if not character.isspace()
        )

    # 4. The per-rule capitalization field wins, and is applied last.
    if capitalization == "uppercase":
        return working.upper()
    if capitalization == "lowercase":
        return working.lower()
    if capitalization == "capitalize":
        return _capitalize_first(working)
    return working


def apply_replacements(text: str, rules: Iterable[Any]) -> str:
    """Stage 5. The user's own ordered find/replace list.

    Why this runs last: the user wrote these rules and the model did not, so
    they are the final authority over both the recogniser and the model.

    Rules apply in order and each sees the previous rule's output, so
    [{a -> b}, {b -> c}] turns "a" into "c". That is a documented consequence
    of layering, not a bug, which is why the user has to control the order.

    A rule that fails to compile is skipped with the others still running. Bad
    config never aborts the pass.
    """
    result = text

    for rule in rules:
        search = _rule_field(rule, "search") or ""
        if not _rule_field(rule, "enabled") or not search:
            continue

        # Escaping is what makes a literal "(c)" match the three characters
        # (c) rather than an empty capture group.
        core = search if _rule_field(rule, "is_regex") else re.escape(search)

        # The (?:...) wrapper keeps an alternation in a user regex from binding
        # loosely against the trim padding. The padding sits inside the match,
        # so it is consumed: trim_before on "," turns "hello , world" into
        # "hello, world".
        prefix = r"\s*" if _rule_field(rule, "trim_before") else ""
        suffix = r"\s*" if _rule_field(rule, "trim_after") else ""
        pattern = prefix + "(?:" + core + ")" + suffix

        try:
            compiled = re.compile(pattern)
        except re.error:
            # One uncompilable user regex must not take the other rules down.
            continue

        # Expanded once per rule, not once per match, so two matches of the
        # same [time] rule cannot straddle a minute boundary.
        replacement = expand_replacement(
            _rule_field(rule, "replace") or "",
            _rule_field(rule, "capitalization"),
        )

        # A function replacer inserts the text literally, so "$1" stays the two
        # characters "$1" and a backslash is not an escape. Passing the string
        # directly to re.sub would expand both.
        result = compiled.sub(lambda _match, value=replacement: value, result)

    return result


if __name__ == "__main__":
    # `python -m cleanup` runs this file, so hand straight over to the command
    # line entry point next door. Loading it under another name keeps it from
    # colliding with this module, which Python has already registered as
    # `__main__`.
    import pathlib
    import runpy
    import sys

    _cli = runpy.run_path(
        str(pathlib.Path(__file__).with_name("__main__.py")), run_name="cleanup._cli"
    )
    sys.exit(_cli["main"](sys.argv[1:]))
