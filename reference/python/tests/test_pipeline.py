"""Hand written integration tests running the stages in the specified order.

The conformance suite covers each stage in isolation. These cover the things
only visible when the stages run together, or that the case file states as a
rule rather than a pair.
"""

from __future__ import annotations

import re

from cleanup import (
    ReplacementRule,
    apply_replacements,
    apply_vocabulary,
    expand_spoken_emoji,
    filter_transcript,
)

VOCABULARY = ["ChargeBee", "OpenAI"]

RULES = [
    ReplacementRule(search="approx", replace="approximately"),
    ReplacementRule(search=r"\s+,", replace=",", is_regex=True),
]


def run_pipeline(
    text: str,
    *,
    lang: str = "en",
    vocabulary=VOCABULARY,
    custom_filler_words=None,
    rules=RULES,
    emoji: bool = True,
    model=None,
) -> str:
    """Stages 1, 2, optional 3, then 4 and 5, in the normative order.

    `model` stands in for stage 3. It may return None or raise, and either way
    the stage 2 text carries forward.
    """
    text = apply_vocabulary(text, vocabulary)
    text = filter_transcript(text, lang, custom_filler_words)

    if model is not None:
        try:
            model_output = model(text)
        except Exception:
            model_output = None
        if model_output:
            text = model_output

    if emoji:
        text = expand_spoken_emoji(text)
    return apply_replacements(text, rules)


def test_clean_sentence_comes_out_byte_identical():
    """Nothing in the pipeline may touch text that has nothing wrong with it."""
    text = "The quarterly report is ready for review."
    assert run_pipeline(text) == text


def test_full_pipeline_applies_each_stage_in_order():
    text = "  So uhm the Charge B invoice went out approx today thumbs up emoji  "
    assert run_pipeline(text) == "So the ChargeBee invoice went out approximately today 👍"


def test_stage_five_overrides_what_the_model_wrote():
    """The user's rules run last, so they win over the model's wording."""
    rules = [ReplacementRule(search="Chargebee", replace="ChargeBee")]
    result = run_pipeline(
        "the invoice",
        vocabulary=[],
        rules=rules,
        model=lambda _text: "The Chargebee invoice.",
    )
    assert result == "The ChargeBee invoice."


def test_model_failure_carries_stage_two_text_forward():
    def broken_model(_text):
        raise TimeoutError("stage 3 timed out")

    result = run_pipeline("So uhm the report is ready", rules=[], model=broken_model)
    assert result == "So the report is ready"


def test_model_returning_nothing_carries_stage_two_text_forward():
    result = run_pipeline("So uhm the report is ready", rules=[], model=lambda _t: "")
    assert result == "So the report is ready"


def test_invalid_user_regex_does_not_abort_the_other_rules():
    rules = [
        {"search": "(unclosed", "replace": "x", "is_regex": True},
        {"search": "teh", "replace": "the"},
    ]
    assert apply_replacements("teh (unclosed group", rules) == "the (unclosed group"


def test_empty_custom_filler_list_disables_filtering():
    text = "So uhm I was thinking uh about this"
    # An empty list means off. None means use the language default. A single
    # truthiness check would collapse the two and silently disable the pass.
    assert filter_transcript(text, "en", []) == text
    assert filter_transcript(text, "en", None) == "So I was thinking about this"


def test_custom_filler_list_replaces_the_language_default():
    text = "okay so uhm this works"
    # "uhm" survives because the custom list took over from the English one.
    assert filter_transcript(text, "en", ["okay"]) == "so uhm this works"


def test_every_stage_is_a_no_op_with_empty_config():
    text = "Nothing configured here."
    assert apply_vocabulary(text, []) == text
    assert filter_transcript(text, "en", []) == text
    assert apply_replacements(text, []) == text
    # Stage 4 has no config, so its no-op case is text with no emoji command.
    assert expand_spoken_emoji(text) == text


def test_order_is_normative_stage_five_after_stage_four():
    rules = [ReplacementRule(search="🔥", replace="[hot]")]
    text = "that release was fire emoji"
    # Stage 4 produces the symbol, then stage 5 sees and rewrites it.
    assert run_pipeline(text, vocabulary=[], rules=rules) == "that release was [hot]"
    # Reversed, stage 5 has nothing to find. This is why order is specified.
    assert apply_replacements(text, rules) == text


def test_date_token_is_the_only_clock_read():
    rules = [ReplacementRule(search="today", replace="[date]")]
    result = apply_replacements("today", rules)
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}", result)


def test_rules_accept_dicts_and_dataclasses_alike():
    as_dict = apply_replacements("teh cat", [{"search": "teh", "replace": "the"}])
    as_object = apply_replacements(
        "teh cat", [ReplacementRule(search="teh", replace="the")]
    )
    assert as_dict == as_object == "the cat"
