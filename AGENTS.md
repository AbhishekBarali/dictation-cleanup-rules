# Agent brief

You are adding rule-based dictation cleanup to an existing app: four functions over
a string, no model anywhere in them. Read this file, then `spec/SPEC.md`. Everything
below is a constraint, not a suggestion.

## Paste this to your agent

> Add the dictation cleanup rules from
> https://github.com/AbhishekBarali/dictation-cleanup-rules to this codebase.
>
> Read `spec/SPEC.md` for the algorithms, `data/*.json` for the pattern tables, and
> `reference/python/cleanup.py` for a working implementation to port from. Then read
> `AGENTS.md` in full before writing code.
>
> Match my project's language, style, and dependency conventions. Do not add a
> language model anywhere in these four rules. When you are done, run
> `conformance/cases.json` against your implementation and tell me how many of the
> 79 cases pass. Do not claim it works until that suite is green.

## What you are building

Five stages over a transcript string. Two before any language model, two after.

```
ASR output → 1 vocabulary → 2 filler/stutter → [3 LLM] → 4 emoji → 5 rules → final
```

Stages 1, 2, 4 and 5 are pure functions of `(text, config)`. Stage 3 is the app's
existing model call, if it has one, and it is not your job here.

## Hard constraints

1. **No model, no network, no randomness** in stages 1, 2, 4, 5. The only clock
   read in the whole pipeline is stage 5's `[date]` / `[time]` tokens.
2. **Order is normative.** Do not reorder, do not merge stages, do not run stage 5
   before stage 3. If the codebase makes the specified order awkward, say so and
   ask; do not quietly reorder.
3. **Empty config is a no-op.** Every stage returns its input unchanged when it has
   nothing configured.
4. **Bad config never aborts the pipeline.** One uncompilable user regex is skipped
   with a warning; the other rules still run.
5. **Stage 3 is allowed to fail.** On timeout or error, carry the stage-2 text into
   stages 4 and 5. Never surface an error to the user in place of their text.
6. **Do not invent behaviour.** If the spec does not say to capitalise something,
   do not capitalise it. These stages delete and substitute. They do not write.

## The traps

These are the places a reimplementation goes wrong silently. Every one has a
conformance case.

**Three-valued filler config.** Absent means "use the language default". A
non-empty list means "use this instead". An **empty list means filtering is off**.
In a language where `[]` is falsy, a single truthiness check collapses empty and
absent and silently disables the pass. Model it as an explicit
`None | List` / `Option<Vec>` / discriminated union.

**Filler tables are per language and are not translations.** `"um"` is an English
filler and the Portuguese article. `"ha"` is Spanish for "has". Never apply the
English list to another language, and if you extend a table, the test is "is this
string a real word in this language", not "is this a filler in mine". The `"*"`
fallback omits `um`, `eh` and `ha` deliberately. Do not add them back.

**Whitespace tidying comes last.** Filler removal leaves double spaces behind.
Collapse `\s{2,}` and trim only after both stage-2 substeps have run.

**Stutter threshold is 3, not 2.** "no no is fine" is a real sentence and "very
very good" is emphasis. Collapse to the **first** occurrence so its original
casing survives: "No NO no NO no" → "No".

**Literal replacements must be regex escaped.** A rule searching for `"(c)"` has to
match the three characters `(c)`, not an empty capture group.

**Replacement text must be inserted literally.** `$1` in a replacement is the two
characters `$1`, never a capture reference. Most regex libraries expand it by
default; you need the explicit no-expand path (`regex::NoExpand` in Rust, a
function replacer in JS, `re.sub` with an escaped repl or a lambda in Python).

**The emoji keyword is mandatory and fuzzy-bounded.** A trailing word within
Damerau-Levenshtein 1 of "emoji", length 4 to 7. That length bound is what keeps
"emojiology" from matching. Without the mandatory keyword every occurrence of
"fire" or "happy" becomes a candidate, and the stage becomes unusable.

**Emoji exact match runs longest-window-first, fuzzy runs shortest-first.** They
are not the same loop. Longest-first on the exact pass is what makes "red heart
emoji" produce ❤️ instead of matching the "heart" suffix.

**Emoji fuzzy matching has an ambiguity veto.** If a second candidate maps to a
different symbol and is within 0.08, change nothing. A near-tie between two emoji
is not a match.

**Vocabulary n-grams go longest-first with a length gate.** Try 3 words, then 2,
then 1. Reject a pair whose lengths differ by more than
`max(max_len * 0.25, 2.0)`; that gate is the only thing stopping "openaigpt" from
matching "openai".

**Restoring punctuation must not duplicate alphanumerics.** The match key already
dropped punctuation, so the prefix/suffix you re-add is the non-alphanumeric run
only. `"GPT4"` against `GPT-4` must give `GPT-4`, never `GPT-44`.

**Skip stage 1 entirely if your recogniser takes a bias prompt.** Whisper's
`initial_prompt` and equivalents bias the decoder, which beats correcting
afterwards. Doing both double-corrects. Two cases in the suite
(`vocab-ngram-window-caps-at-three`, `vocab-accented-neighbour-*`) pin real
limitations of stage 1 that biasing avoids entirely; read `NOTES.md` before you
promise a user that stage 1 is reliable.

## Dependencies you may need

Stage 1 needs Levenshtein distance and Soundex. Stage 4 needs Damerau-Levenshtein,
raw and normalised. Prefer a small well-known library in your ecosystem over
writing them; if you must write them, write them in one file with their own tests.
The Python reference implements all four in about sixty lines with no dependencies,
so you can port from there rather than pulling anything in.

## Definition of done

- All four pure stages implemented, wired in the specified order.
- `conformance/cases.json` runs against your implementation and all 79 cases pass,
  per stage, in isolation. Report the count.
- The three-valued filler config is modelled explicitly, not as a truthiness check.
- Stage 3, if present, cannot take the pipeline down.
- You have not added a model call to any of stages 1, 2, 4, 5.

Report what you skipped and why. A partial implementation that says so is useful;
one that claims conformance it did not run is not.
