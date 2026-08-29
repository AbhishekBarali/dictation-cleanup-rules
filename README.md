# Deterministic dictation cleanup

The rule-based cleanup that runs in [SpeakoFlow](https://github.com/AbhishekBarali/SpeakoFlow)
before any language model gets involved, extracted into a portable spec, a data
set of patterns, and reference implementations you can drop into your own app.

No model, no weights, no GPU. Four passes over a string.

## Why you probably want this

If you are running a dictation cleanup model and your results are worse than the
numbers on someone's model card, this is a likely reason. The numbers were almost
certainly measured on a pipeline that already did the boring work in code, so the
model only ever saw the hard residual. Point the same model at raw recogniser
output and it has to redo all of that, from a prompt, on every request. It will be
slower and it will sometimes get it wrong.

That is the honest caveat on my own benchmark
([dictation-cleanup-bench](https://github.com/AbhishekBarali/dictation-cleanup-bench)),
and it is why this repository exists. The four passes below are the missing half.

## The argument

Deterministic work belongs in deterministic code.

Removing "um" is a table lookup. Collapsing "wh wh wh wh" is a loop. Fixing the
spelling of your company name is a dictionary. None of that needs a language
model, and routing it through one costs latency, costs money if you are calling an
API, and buys variance you did not want: a model asked to drop a filler word will
occasionally rewrite the sentence around it.

So do those four things in code, in about a millisecond, with the same answer
every single time. Then hand what is left to the model. What is left is the
genuinely ambiguous part, and that is where a model earns its keep: retractions
("three hundred, no, three fifty"), spoken commands, format intent, words that
were transcribed correctly and are still the wrong word.

The model sits on top. It does not sit underneath, and it does not do both jobs at
once.

## The pipeline

```
ASR output  →  1 vocabulary  →  2 filler/stutter  →  [ 3 LLM ]  →  4 emoji  →  5 rules  →  final
                      pre-model                     optional            post-model
```

| # | Pass | What it does | Default |
|---|---|---|---|
| 1 | Vocabulary correction | fuzzy-matches proper nouns and jargon, including across word splits ("Charge B" → `ChargeBee`, "Chat G P T" → `ChatGPT`) | on when the user has a word list |
| 2 | Filler and stutter filter | drops hesitation sounds using a per-language table, collapses 3+ repeats, tidies whitespace | on |
| 3 | Language model | the ambiguous residual only, and it is allowed to fail | opt-in |
| 4 | Spoken emoji | expands "thumbs up emoji" → 👍, and only with the trailing keyword | off |
| 5 | User replacement rules | the user's own ordered find/replace with a small template language | off |

Order is part of the design. Stages 1 and 2 shrink what the model reads. Stages 4
and 5 override what the model wrote, because the user authored those rules and the
model did not. If a user's rule says their product is spelled "ChargeBee", that
rule wins over the model's opinion. Running rules first would let the model undo
them.

Stage 3 is the only stage allowed to be wrong in an interesting way. Everything
else is a table.

## What is in here

| Path | |
|---|---|
| `spec/SPEC.md` | the normative spec: exact algorithms, thresholds, edge cases, language independent |
| `data/filler_words.json` | filler tables for 16 languages plus a conservative fallback |
| `data/emoji_aliases.json` | 182 spoken-emoji phrases mapping to 77 symbols |
| `conformance/cases.json` | 78 fixed input/output pairs: every case from the Rust test suite plus Soundex and accented-input coverage |
| `reference/python/` | reference implementation, zero required dependencies, passes conformance |
| `reference/typescript/` | port, passes the same conformance suite |
| `vendor/*.rs` | the original SpeakoFlow Rust source, MIT, unmodified |
| `DIVERGENCES.md` | where the Rust, the spec and a naive port disagree, including four bugs to fix upstream |
| `AGENTS.md` | paste-in brief so a coding agent can implement this in your codebase |
| `INSTALL.md` | wiring it into an existing app, in order, with the traps |

## Start here

**Reading it yourself:** `spec/SPEC.md`, then `reference/python/cleanup.py`
alongside it. The Python file is written to be read, not to be fast.

**Trying it:**

```bash
cd reference/python
python -m cleanup "So uhm I was, uh, thinking about this"
python -m pytest        # conformance suite
```

**Having an agent do it:** point your coding agent at `AGENTS.md`. It is written
as a brief, with the traps called out, because most of them are the kind a
reimplementation gets wrong silently.

## Two things that will bite you

**The three-valued filler config.** No custom list means use the language default.
A non-empty custom list replaces the default. An **empty** list means filtering is
off. Collapsing empty and absent into one falsy check is the most common port bug,
and it silently disables the pass.

**Per-language filler tables are not translations.** `"um"` is an English filler
and the Portuguese word for "a/an". `"ha"` is Spanish for "has". One global filler
list quietly corrupts text in every language it was not written for. The fallback
table deliberately omits `um`, `eh` and `ha` for exactly this reason.

## Conformance

`conformance/cases.json` is the contract. A port is conformant when it reproduces
every expected output byte for byte, per stage, in isolation. Both reference
implementations pass it. If you write a port in another language, run it against
the same file and open a PR.

Add cases when you add behaviour. Do not delete a case to make a port pass.

## Scope

In scope: the four deterministic passes, their data, and enough spec to reproduce
them anywhere.

Out of scope: the recogniser, the cleanup model, the prompt, and anything that
needs weights. Note that a modern recogniser (Parakeet, Nemotron) already does
punctuation, capitalisation and number formatting. Speak "the deposit is three
hundred dollars, um, and the meeting is at nine thirty" into Parakeet and you get
"The deposit is $300 and the meeting is at 9:30" with no model involved. Do not
build a pass for work your recogniser already did.

## Licence

MIT, same as SpeakoFlow. The vendored Rust keeps its original copyright header.
