# Notes from porting this twice

Implementing the spec independently in Python and TypeScript, then diffing the two
against the same inputs, found things that reading the Rust once did not. This file
records all of them.

Nothing here has been observed failing in the shipping app. These are findings from
reading code and running the ports, and they are written that way. Where something
is a limitation rather than a defect, it says so.

`vendor/*.rs` is authoritative. Where a reference implementation deviates, that is
stated and justified.

## Two limits you should know about before you rely on rule 1

**A spoken acronym longer than three words cannot be matched.** The scan tries
windows of 3, 2 and 1 word, so a vocabulary entry that arrives as four spoken words
matches on its first three and orphans the rest:

```
vocabulary: ["ChatGPT"]
in    we should use Chat G P T for the draft
out   we should use ChatGPT T for the draft
```

This happens at the default `0.18` threshold on an ordinary sentence, and both
ports reproduce it. The existing Rust test asserts only that the output *contains*
`ChatGPT`, which is true of the broken output, which is why it went unnoticed.
Pinned as `vocab-ngram-window-caps-at-three`. Raising the window to 4 or 5 would fix
this class and would also widen the over-match risk below, so it is a real
trade-off rather than an oversight to correct blindly.

**A window can absorb a neighbouring word.** Longest-first matching means a window
that happens to score well can swallow a word that was not part of the intended
match:

```
vocabulary: ["ChargeBee"]
in            il cui nome è Charge B, che permette
out (0.18)    il cui nome è ChargeBee permette      ("che" gone)
out (0.50)    il cui nome ChargeBee, che permette   ("è" gone)
```

Pinned as `vocab-accented-neighbour-*`. Both of these are the strongest argument in
this repository for **biasing the recogniser's decoder instead of running rule 1 at
all**, which is what SpeakoFlow already does for Whisper-family models: pass the
vocabulary as the recogniser's prompt and skip the after-the-fact correction
entirely. Correcting a word the decoder already got wrong is the weaker position.

## Smaller things in the Rust, found by reading

None of these has been reported or observed. They are code-reading notes, offered
in case they are useful.

**`extract_punctuation` mixes character counts and byte offsets.** It counts the
leading and trailing non-alphanumeric runs in characters, then slices the string
using those counts as byte indices. For ASCII input the two are the same and it is
correct. A word wrapped in non-ASCII punctuation, such as `«hello»` or typographic
quotes, would slice mid-character. Whether any real transcript reaches it depends on
what the recogniser emits and what is in the user's vocabulary list, and I have not
constructed an input to check.

**The length gate mixes bytes and characters too.** `candidate.len()` is a byte
count and `strsim::levenshtein` counts characters, so on accented input the
normalised score comes out lower than the true distance and rule 1 is slightly more
willing to match than the threshold implies.

**`natural::phonetics::soundex` indexes `chars[0]` with no length check.** Rule 1
rejects empty candidates and empty vocabulary keys before it gets there, so nothing
reaches it with an empty string today.

## Soundex is not the textbook algorithm

An early draft of the spec said "standard Soundex". That was wrong, and it is worth
knowing if you port this.

The Rust calls `natural::phonetics::soundex`, which **carries the first character
through literally** rather than coding it, and treats every character outside `a-z`
as a vowel rather than filtering it out. Textbook Soundex codes the first letter and
then drops a following letter sharing its code, so it gives `S000` for "sc" and
`P236` for "pfister" where this gives `s200` and `p123`.

This is not academic. The first TypeScript version filtered non-ASCII letters before
coding, so `"èchargeb"` coded as `c621`, matched `"chargebee"` phonetically, and
rule 1 swallowed the `è`. **It passed all 64 conformance cases that existed at the
time.** Only running both ports on the same input found it. The suite now has a
`soundex` stage specifically to catch this, and `spec/SPEC.md` specifies the real
variant. If you write a third port, get that stage green first.

## Deliberate deviations in the reference implementations

**Characters, not bytes.** Both ports measure and index in characters throughout,
which is the spec's wording and the only sane choice in Python and JavaScript. The
Rust's byte arithmetic is documented above rather than copied.

**JavaScript `\b` is ASCII-only,** so it never fires next to an accented letter and
the German filler `äh` would never be removed. The TypeScript port uses
`(?<![\p{L}\p{N}])` and `(?![\p{L}\p{N}])` with the `u` flag instead. If your
language's word boundary is ASCII-only, do the same, or filler removal silently
stops working for every language with an accented filler.

**Empty input to Soundex** returns `""` in both ports rather than panicking, and an
empty code never counts as a phonetic match.

**A word with no alphanumerics reports itself as both punctuation runs.**
`extract_punctuation("...")` returns `("...", "...")`, because the two runs are
counted independently and overlap. The Rust and the spec's wording both produce
this, and rule 1 cannot reach it, so both ports keep it rather than inventing new
behaviour.

## Found another one?

Open an issue with the input, both outputs, and which rule. A difference only one
port shows is a port bug. A difference both ports show against the Rust is either a
spec bug or a Rust bug, and it gets written down here either way.
