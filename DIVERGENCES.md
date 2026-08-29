# Divergences

Porting the pipeline twice surfaced places where the Rust, the spec, and a
straightforward reimplementation do not agree. This file records all of them so
nobody rediscovers them by shipping a bug.

`vendor/*.rs` is authoritative for anything the benchmark measured. Where the
reference implementations deviate from it, that is stated and justified below.

## Bugs to fix in SpeakoFlow

These are live defects in the vendored Rust, found while porting. None of them
change the benchmark numbers, because no benchmark row reaches them.

**`extract_punctuation` can panic on non-ASCII punctuation.** `vendor/text.rs`
counts the leading and trailing non-alphanumeric runs in **characters** and then
slices the string with those counts as **byte** indices. A transcript word like
`«hello»` or one wrapped in typographic quotes slices mid-character and panics.
Guillemets and curly quotes are exactly what a dictation pipeline produces in
French, German and Spanish.

**The length gate mixes bytes and characters.** `vendor/text.rs` uses
`candidate.len()`, the UTF-8 byte length, for the length gate, the 50 character
cap, and the divisor that normalises the Levenshtein score. `strsim::levenshtein`
counts characters. On accented input the Rust therefore divides a character count
by a byte count and reports a score lower than the true normalised distance,
which makes stage 1 slightly more willing to match accented text than intended.

**`natural::phonetics::soundex` panics on an empty string.** It indexes `chars[0]`
with no length check. Stage 1 never reaches it with an empty string, since empty
candidates and empty vocabulary keys are both rejected earlier, so this is latent
rather than live. Still worth a guard.

**Greedy n-grams can absorb a neighbouring word.** On
`"il cui nome è Charge B, che permette"` with vocabulary `["ChargeBee"]`, the
longest-first scan matches across the boundary and consumes a word that was not
part of the intended match. At the default threshold `0.18` the output is
`"il cui nome è ChargeBee permette"`, losing `"che"`; at `0.5` it is
`"il cui nome ChargeBee, che permette"`, losing `"è"`. Both reference
implementations reproduce this exactly, and there are conformance cases pinning
it (`vocab-accented-neighbour-*`), so a fix has to be a deliberate change with
updated cases, not a silent divergence. This is the strongest argument in the
whole repository for biasing the decoder instead of running stage 1 at all.

## Spec corrections already applied

**Soundex is not the textbook algorithm.** An earlier draft of `spec/SPEC.md` said
"standard Soundex, 4 characters". That was wrong. The Rust carries the first
character through literally rather than coding it, and treats every character
outside `a-z` as a vowel rather than filtering it out. `spec/SPEC.md` now
specifies the real variant and `conformance/cases.json` has a `soundex` stage
pinning it.

That stage exists because of a live bug caught between the two ports. The first
TypeScript version filtered non-ASCII letters before computing the code, so
`"èchargeb"` coded as `c621` and matched `"chargebee"` phonetically, and stage 1
happily swallowed the `è`. It passed all 64 original conformance cases. Only a
direct comparison of the two ports on the same input found it. If you write a
third port, run the `soundex` stage first.

## Deliberate deviations in the reference implementations

**Characters, not bytes.** Both ports index and measure in characters throughout,
which is the spec's wording and the only sane choice in Python and JavaScript. The
Rust's byte-length arithmetic is documented above as a bug rather than copied.
Ports to byte-oriented languages should read the spec as characters.

**JavaScript `\b` is ASCII-only.** `\b` in a JavaScript regex never fires next to
a non-ASCII letter, so the German filler `äh` would never be removed. The
TypeScript port uses Unicode lookarounds, `(?<![\p{L}\p{N}])` and
`(?![\p{L}\p{N}])` with the `u` flag, which reproduces the Rust's behaviour. If
your language's `\b` is ASCII-only, do the same. If you skip this, filler removal
silently stops working for every language with an accented filler.

**Empty and letterless input to Soundex.** The Rust panics on empty input. Both
ports return `""` and the TypeScript port additionally treats an empty code as
never matching, so two letterless strings are not reported as phonetically equal.

**A word with no alphanumerics reports itself as both punctuation runs.**
`extract_punctuation("...")` returns `("...", "...")`, because the leading and
trailing runs are counted independently and overlap. Both the Rust and the spec's
wording produce this, and stage 1 cannot reach it, so both ports keep the
behaviour rather than inventing a new one.

## If you find another one

Open an issue with the input, the two outputs, and which stage. A divergence that
only one port exhibits is a port bug. A divergence both ports exhibit against the
Rust is either a spec bug or a Rust bug, and this file is where it gets written
down either way.
