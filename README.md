# Dictation cleanup rules

Dictation gives you text with hesitation sounds in it, repeated words, and your
company's name spelled wrong. This is the code that fixes those, by rule, before
any AI model is involved. Lifted out of [SpeakoFlow](https://github.com/AbhishekBarali/SpeakoFlow)
and written up so you can add it to your own app in any language.

```
in    So uhm I was, uh, thinking about this
out   So I was, thinking about this

in    No NO no NO no that is not what I meant
out   No that is not what I meant

in    w wh wh wh wh why did that happen
out   w wh why did that happen

in    send the invoice to Charge B before Friday        (vocabulary: ChargeBee)
out   send the invoice to ChargeBee before Friday

in    That worked fire emoji ship it rocket emoji
out   That worked 🔥 ship it 🚀

in    This is a completely normal sentence.
out   This is a completely normal sentence.             (unchanged, as it should be)
```

Every line above is real output from `reference/python`, not an illustration.

## Who this is for

**If you are building a dictation or voice app,** this is a cleanup layer you can
drop in. It is four functions over a string, no model, no weights, no GPU, about a
millisecond. It handles the parts of cleanup that are a table lookup, so whatever
you do afterwards has less to do.

**If you are running SpeakoFlow Mini** (the cleanup model, on Hugging Face soon:
`AbhishekBarali/speakoflow-mini`) and the output is not as good as you expected,
this is probably the missing piece. Mini is trained on what is left *after* these
rules run. Hand it raw recogniser output and you are asking it to do work it was
not trained for, from a prompt, on every request.

## Try it

```bash
git clone https://github.com/AbhishekBarali/dictation-cleanup-rules
cd dictation-cleanup-rules/reference/python
python -m cleanup "So uhm I was, uh, thinking about this"
python -m cleanup --lang pt "um gato bonito"
python -m cleanup --vocab ChargeBee "send the invoice to Charge B"
python -m cleanup --emoji "nice work thumbs up emoji"
```

No install, no dependencies. TypeScript is in `reference/typescript` if that suits
you better.

## Have your coding agent add it for you

Paste this to Claude Code, Cursor, Kiro, or whatever you use:

> Add the dictation cleanup rules from
> https://github.com/AbhishekBarali/dictation-cleanup-rules to this codebase.
> Read `AGENTS.md` first, then `spec/SPEC.md` for the algorithms and
> `reference/python/cleanup.py` for a working implementation to port from. Match
> my project's language and conventions. When you are done, run
> `conformance/cases.json` against your implementation and tell me how many of
> the 79 cases pass. Do not claim it works until that suite is green.

`AGENTS.md` is written for this: it lists the places a reimplementation goes wrong
silently, and every one of them has a test case waiting in the conformance suite.
So the agent cannot tell you it worked when it did not.

## What the four rules do

| | Rule | Fixes |
|---|---|---|
| 1 | Vocabulary | your jargon and proper nouns, including when one written word arrives as several spoken ones. "Charge B" becomes `ChargeBee` |
| 2 | Filler and repeats | hesitation sounds using a per-language table, plus runs of 3 or more identical words, plus the double spaces that leaves behind |
| 3 | Spoken emoji | "thumbs up emoji" becomes 👍, and only with that trailing keyword, so the word "fire" on its own is safe |
| 4 | Your own rules | an ordered find/replace list with a small template language, for the fixes only you need |

Rules 1 and 2 run **before** your model. Rules 3 and 4 run **after** it, so a rule
the user wrote always beats whatever the model decided. Rule 2 alone is the
cheapest win here; take that one even if you skip the rest.

(`spec/SPEC.md` numbers these 1, 2, 4 and 5, with the model as stage 3, because
the spec cares about pipeline position. Same four functions.)

## Why rules instead of asking the model

Removing "um" is a table lookup. Collapsing "wh wh wh wh" is a loop. Spelling your
company name correctly is a dictionary. Sending that to a language model costs
latency, costs money if it is an API, and buys you variance you did not want: a
model told to drop a filler word will sometimes rewrite the sentence around it.

Do those in code, in a millisecond, with the same answer every time. Then let the
model work on what is genuinely ambiguous, which is where it earns its keep:
retractions ("three hundred, no, three fifty"), spoken commands, format intent,
words transcribed correctly that are still the wrong word.

The model goes on top. Not underneath, and not doing both jobs at once.

## Also worth knowing

**Check what your recogniser already does before you write anything.** Parakeet,
Nemotron and current Whisper builds already handle punctuation, capitalisation and
number formatting. Speak "the deposit is three hundred dollars, um, and the meeting
is at nine thirty" into Parakeet and you get "The deposit is $300 and the meeting
is at 9:30" with no model involved. Do not build a pass for work that is already
done.

**The filler setting has three states, not two.** Unset means use the language
default. A list means use that list instead. An **empty** list means filtering is
off. Collapsing empty and unset into one truthiness check is the most common port
bug and it silently disables the pass.

**Filler tables are per language and are not translations of each other.** `"um"`
is an English filler and the Portuguese word for "a/an". `"ha"` is Spanish for
"has". One global filler list quietly corrupts text in every language it was not
written for.

## What is in here

| Path | |
|---|---|
| `spec/SPEC.md` | the algorithms in full, language independent, every threshold and edge case |
| `data/filler_words.json` | filler tables for 16 languages plus a conservative fallback |
| `data/emoji_aliases.json` | 182 spoken-emoji phrases mapping to 77 symbols |
| `conformance/cases.json` | 79 fixed input/output pairs. Run these against your port |
| `reference/python/` | written to be read from, zero dependencies |
| `reference/typescript/` | port, passes the same suite |
| `AGENTS.md` | the agent brief, and the list of silent failure modes |
| `INSTALL.md` | wiring order, settings to expose, what to verify |
| `NOTES.md` | limits found while porting this twice, including two you should know about |
| `vendor/*.rs` | the original Rust, unmodified |

## Conformance is the point

`conformance/cases.json` is what makes "I ported this correctly" checkable instead
of assertable. Every case is a fixed input and its expected output. Run the stages
in isolation and compare byte for byte. Both reference implementations pass all 79.

Two of those cases pin behaviour that is arguably wrong rather than right, because
it is what the shipped code does and a change should be deliberate. `NOTES.md`
explains which and why.

If you port this to another language, run the same file and open a PR.

## Licence

MIT, same as SpeakoFlow. The vendored Rust keeps its original copyright header.
