# Python reference implementation

The four deterministic stages from [`spec/SPEC.md`](../../spec/SPEC.md), with no
third-party runtime dependencies. Levenshtein, Soundex, Damerau-Levenshtein and
its normalised form all live in [`_distance.py`](_distance.py) so there is
nothing to install and nothing to chase when you port this.

This is a readability-first reference, not a performance implementation. It
rebuilds lists where a real port would slice, recompiles a filler pattern per
call, and prefers a spelled-out loop over a clever one. Read it, port it, then
optimise in your own codebase.

## Files

| File | What it holds |
|---|---|
| `cleanup.py` | the four stages and the two helpers the conformance suite names |
| `_distance.py` | the four string metrics |
| `_data.py` | loads `data/filler_words.json` and `data/emoji_aliases.json` from the repository root |
| `__main__.py` | the command line entry point |
| `tests/` | the conformance suite, the pipeline tests, and the metric tests |

## Public API

```python
from cleanup import (
    apply_vocabulary,      # stage 1, pre-model
    filter_transcript,     # stage 2, pre-model
    expand_spoken_emoji,   # stage 4, post-model
    apply_replacements,    # stage 5, post-model
)

text = apply_vocabulary(raw, ["ChargeBee", "OpenAI"], threshold=0.18)
text = filter_transcript(text, lang="en", custom_filler_words=None)
# stage 3 is your model, and it is allowed to fail
text = expand_spoken_emoji(text)
text = apply_replacements(text, [{"search": "teh", "replace": "the"}])
```

`apply_replacements` takes dicts or `ReplacementRule` instances. Missing fields
take the defaults listed in the spec.

Two helpers are public because the conformance suite tests them directly:
`preserve_case_pattern(original, replacement)` and
`extract_punctuation(word) -> (prefix, suffix)`.

Note the three-valued third argument to `filter_transcript`. `None` uses the
built-in list for the language, a non-empty list replaces it, and an empty list
turns filtering off.

## Run it

From this directory:

```bash
python -m cleanup "So uhm I was thinking about this"
python -m cleanup --lang pt "um gato bonito"
python -m cleanup --vocab ChargeBee "the Charge B invoice"
python -m cleanup --emoji "That worked fire emoji"
```

The command line runs stages 1, 2 and 4. Stage 3 is a model and is out of scope
here; stage 5 needs rules, so call `apply_replacements` from your own code.

## Run the conformance suite

```bash
pip install -e ".[dev]"    # pytest only
python -m pytest
```

`tests/test_conformance.py` reads
[`conformance/cases.json`](../../conformance/cases.json) and turns every case
into one test named after its case id, so a failure names the behaviour that
broke. `tests/test_pipeline.py` covers what only shows up when the stages run
together: order, model failure, and empty config.

All 78 conformance cases pass.

## Where the spec and the vendored Rust disagree

The Rust in [`vendor/`](../../vendor/) is authoritative, so this port follows it
and the notes below record what the spec says differently. None of these are
exercised by a conformance case, which is why they went unnoticed.

**Soundex is not the standard one.** `spec/SPEC.md` section 1 says "standard
Soundex, 4 characters". `vendor/text.rs` calls
`natural::phonetics::soundex`, which carries the first character through
literally instead of coding it. Textbook Soundex codes the first letter too and
then drops a following letter that shares its code, so textbook gives P236 for
"pfister" and S000 for "sc" while this gives p123 and s200. Both agree on every
pair the conformance cases reach ("helo" and "hello" are h400 either way). This
port matches the Rust. Either fix the spec wording or change the Rust and add
cases; the two cannot both be right.

**The length gate measures bytes in Rust and characters in the spec.**
`vendor/text.rs` uses `candidate.len()`, which is the UTF-8 byte length, for the
length gate, the 50 character cap, and the divisor that normalises the
Levenshtein score. `strsim::levenshtein` counts characters, so for accented
input the Rust divides a character count by a byte count and reports a score
lower than the true normalised distance. The spec says characters throughout.
This port uses characters, because a byte length would make the reference behave
differently in Python 3, where strings are sequences of characters. Ports to
byte-oriented languages should read this as characters too.

**`extract_punctuation` panics in Rust on non-ASCII punctuation.**
`vendor/text.rs` counts the leading and trailing runs in characters and then
slices with those counts as byte indices. A word such as `«hello»` or a
transcript using typographic quotes slices mid-character and panics. Python has
no equivalent failure, and this port is character-indexed throughout, so the
behaviour here is what the spec describes. Worth fixing in the Rust regardless.

**`natural::phonetics::soundex` panics on an empty string.** It indexes
`chars[0]` without a length check. Stage 1 never reaches it with an empty string
(empty candidates and empty vocabulary keys are both rejected earlier), so this
is latent rather than live. `soundex("")` returns `""` here.

**A word with no alphanumerics reports itself as both runs.**
`extract_punctuation("...")` returns `("...", "...")`, because the two runs are
counted independently and overlap. The spec's wording produces the same result,
and stage 1 cannot reach it (such a word has an empty match key and is
rejected), so this port keeps the behaviour rather than inventing a new one.

## Layout note

The directory is flat and has no `src/`, so `cleanup.py` sits directly on
`sys.path` when you work from here. That is what makes `python -m cleanup` find
it. `conftest.py` puts this directory on `sys.path` for pytest, and the
`__main__` guard at the bottom of `cleanup.py` hands `python -m cleanup` over to
`__main__.py`.
