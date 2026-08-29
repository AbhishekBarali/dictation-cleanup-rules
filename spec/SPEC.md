# Specification

Normative description of the four deterministic passes. It is written so you can
implement it in any language without reading Rust. The Rust source that produced
the benchmark numbers is vendored under `../vendor/` and is authoritative when
this document and the code disagree; report the disagreement as a bug.

Requirements language: MUST, SHOULD, MAY as in RFC 2119.

## 0. Pipeline contract

Five stages. Two run before any language model, two run after, and the model sits
in the middle.

```
ASR output
  │
  ├─ 1. Vocabulary correction        (pre-model, skip when the ASR took a bias prompt)
  ├─ 2. Filler and stutter filter    (pre-model)
  │
  ├─ 3. Language model cleanup       (optional, may be absent or may time out)
  │
  ├─ 4. Spoken emoji expansion       (post-model, opt-in)
  └─ 5. User replacement rules       (post-model, opt-in, final authority)
  │
final text
```

Rules that hold for every stage:

- **A stage MUST be a pure function of `(text, config)`.** No network, no clock
  except stage 5's `[date]`/`[time]`, no randomness, no model.
- **A stage MUST return the input unchanged when its config is empty.** An empty
  vocabulary, an empty filler list, zero rules: all no-ops.
- **A stage MUST NOT abort the pipeline on bad config.** An uncompilable regex in
  one rule is skipped with a warning; the other rules still run.
- **Stage 3 MUST be able to fail without taking the pipeline down.** On timeout
  or error, carry the stage-2 text forward into stages 4 and 5.
- **Order is normative.** Stages 1 and 2 shrink and correct what the model reads,
  and stages 4 and 5 override what the model wrote. Reordering changes output.

### Why the split

Stage 1 and 2 run first because they remove problems the model would otherwise
have to reason about, which is both slower and less reliable than a table lookup.
A model asked to drop "um" sometimes rewrites the sentence around it.

Stage 4 and 5 run last because the user wrote them and the model did not. If a
user has a rule saying their company is spelled "ChargeBee", that rule has to win
over whatever the model produced. Running rules first would let the model undo
them.

Stage 3 is the only stage allowed to be wrong in an interesting way. Everything
around it is a table.

## 1. Vocabulary correction

**Purpose.** Recover proper nouns and jargon that the recogniser rendered as
ordinary words, including cases where one written word arrives as several spoken
ones ("Charge B" for "ChargeBee", "Chat G P T" for "ChatGPT").

**Signature.** `apply_vocabulary(text, vocabulary, threshold) -> text`

`vocabulary` is the user's list of exact spellings. `threshold` is a distance
ceiling; lower is stricter. **Default: `0.18`.**

**When to skip.** If the recogniser accepts a bias or hot-word prompt (Whisper's
`initial_prompt`, for example), pass the vocabulary there instead and skip this
stage. Biasing the decoder is strictly better than correcting after the fact.
Doing both double-corrects.

### Match keys

A **match key** is the input string reduced to lowercase alphanumeric characters,
everything else dropped. `"R&D"` becomes `"rd"`; `"MacBook Pro"` becomes
`"macbookpro"`.

For each vocabulary entry, build:

1. The primary key (as above). Skip the entry if the key is empty.
2. If the entry contains `&`, an additional key from the entry with `&` replaced
   by `" and "`. `"R&D"` therefore also yields `"rand"`, so the spoken form
   "R and D" matches. Skip if identical to the primary key.

Both keys point back to the same entry, whose original spelling is what gets
inserted.

### Scan

Split `text` on whitespace into a word list. Walk it left to right with index
`i`. At each position, try n-grams of length 3, then 2, then 1 (**longest
first**, so "Open AI GPT" prefers `OpenAI` over `GPT`). For each n-gram:

1. Build its match key by concatenating the per-word match keys, no separator.
2. Run the scorer below against every vocabulary key.
3. On a match: emit `prefix + cased_replacement + suffix`, advance `i` by n, and
   stop trying shorter n-grams at this position.

If nothing matched at any length, emit `words[i]` verbatim and advance by 1.
Join the output with a single space.

- `prefix` is the leading non-alphanumeric run of the n-gram's **first** word.
- `suffix` is the trailing non-alphanumeric run of the n-gram's **last** word.
- `cased_replacement` applies the case rule below.

Because the match key already dropped punctuation, restoring prefix and suffix
must not re-add characters the key kept. `"GPT4"` against `GPT-4` must yield
`GPT-4`, never `GPT-44`: the trailing `4` is alphanumeric, so it is part of the
key and not part of the suffix.

### Scorer

For a candidate key `c` and a vocabulary key `v`:

1. Reject if `c` is empty or longer than 50 characters.
2. **Length gate.** Reject if `abs(len(c) - len(v)) > max(max(len(c), len(v)) * 0.25, 2.0)`.
   This is what stops a long n-gram from swallowing a short entry
   ("openaigpt" must not match "openai"). Lengths are **character** counts, not
   bytes; see `../NOTES.md` for what the Rust does here.
3. `lev = levenshtein(c, v) / max(len(c), len(v))`, or `1.0` when both are empty.
4. `phonetic = soundex(c) == soundex(v)`, using the Soundex variant below.
5. `score = lev * 0.3` if `phonetic` else `lev`.
6. Accept if `score < threshold` **and** `score < best_score_so_far`.

Lower is better. Ties keep the earlier candidate. The `0.3` factor means a
phonetic match tolerates roughly three times the spelling distance, which is the
point: dictation errors are heard, not typed.

### Soundex variant

**This is not textbook (NARA) Soundex.** It is what
`natural::phonetics::soundex` computes, which is what produced the benchmark
numbers, so it is what a port must reproduce. Four characters, and:

1. The **first character is carried through literally**, not coded. Textbook
   Soundex codes the first letter and then drops a following letter sharing its
   code, so textbook gives `S000` for "sc" and `P236` for "pfister" where this
   gives `s200` and `p123`.
2. Every character after the first is coded: `bfpv`→1, `cgjkqsxz`→2, `dt`→3,
   `l`→4, `mn`→5, `r`→6, `h`/`w`→a drop marker. **Every other character,
   including digits and any letter outside `a-z`, codes as a vowel.**
3. Drop the `h`/`w` markers **first**, so they cannot keep two equal codes
   apart.
4. Collapse adjacent equal codes to one.
5. Drop vowels **after** collapsing, which is what lets a vowel separate two
   equal codes.
6. Right-pad with `0` and truncate to 4 characters. Empty input gives `""`.

Do **not** filter non-`a-z` characters out before step 1. A port that does will
pass every other case in the suite and still over-match across an accented
leading character: `"èchargeb"` must code `è262`, not `c621`, or stage 1 absorbs
the `è` into a `ChargeBee` match. `conformance/cases.json` has a `soundex` stage
specifically to catch this.

### Case rule

Given the n-gram's first word `original` and the vocabulary spelling `replacement`:

- Every character of `original` uppercase -> `replacement.upper()`
- First character of `original` uppercase -> `replacement` with its first
  character uppercased, rest untouched
- Otherwise -> `replacement` verbatim

Note the middle branch preserves the rest of the vocabulary spelling, so
`"Chargebee"` in the transcript still produces `ChargeBee`.

## 2. Filler and stutter filter

**Purpose.** Remove hesitation sounds and repetition artefacts. This is the pass
most people mean by "cleanup", and it needs no model at all.

**Signature.** `filter_transcript(text, lang, custom_filler_words) -> text`

`custom_filler_words` is three-valued and the distinction matters:

| Value | Meaning |
|---|---|
| absent / `null` / `None` | use the built-in list for `lang` |
| a non-empty list | use that list instead of the built-in one |
| an empty list | **filtering off** |

### Language selection

Take `lang` up to the first `-` or `_`, so `pt-BR` resolves as `pt`. Look the
result up in `../data/filler_words.json`. An unknown code uses the `"*"` entry.

The per-language lists are not translations of each other, and this is the whole
reason the table exists. `"um"` is an English filler and the Portuguese word for
"a/an". `"ha"` is an English filler and Spanish for "has". `"ah"` is an English
filler and appears in many languages as a real word. A single global filler list
corrupts text in every language it was not written for, which is why the `"*"`
fallback deliberately omits `um`, `eh` and `ha`.

If you extend the table, the test is not "is this a filler in my language" but
"is this string a word in the language I am adding it for". When unsure, leave it
out. A missed "um" is invisible; a deleted article is a bug report.

### Steps, in order

1. **Filler removal.** For each filler word `w`, in list order, replace every
   match of `(?i)\b<escaped w>\b[,.]?` with the empty string. `w` MUST be regex
   escaped. The optional trailing `[,.]` is what turns "Well, uhm, I think" into
   "Well, I think" instead of leaving an orphan comma.
2. **Stutter collapse.** Split on whitespace. A run of **3 or more**
   case-insensitively identical words collapses to the **first** occurrence,
   which preserves its original casing ("No NO no NO no" -> "No"). Only runs
   whose word is entirely alphabetic are eligible, so "1 1 1" and "-- -- --"
   survive. Two repetitions are left alone: "no no is fine" is a real English
   sentence, and "very very good" is emphasis, not a stutter.
3. **Whitespace collapse.** Replace `\s{2,}` with a single space.
4. **Trim** leading and trailing whitespace.

Steps 3 and 4 MUST come last, because step 1 leaves double spaces behind wherever
it deleted a word.

### What this stage must not do

It MUST NOT add, reorder, or re-case any word it is not deleting. It has no
notion of a sentence. If your implementation ever wants to capitalise something,
you have put a model's job in a table's stage.

## 3. Language model cleanup (out of scope, boundary specified)

This repository does not specify the model, prompt, or provider. It specifies the
boundary:

- The model reads the output of stage 2 and nothing else.
- Its output MUST be treated as advisory. If the call errors, times out, or
  returns empty, discard it and carry the stage-2 text forward.
- Its output MUST then be passed through stages 4 and 5, which can and should
  overwrite it.

The reason this stage is last-resort rather than first-resort: everything above it
is a table lookup that costs microseconds and behaves identically on every run.
Whatever remains after stage 2 is genuinely ambiguous, and that residual is where
a model earns its latency. Sending raw ASR output straight to a model asks it to
redo four tables and hope it agrees with itself.

## 4. Spoken emoji expansion

**Purpose.** Turn "thumbs up emoji" into 👍 without turning the word "fire" into
🔥.

**Signature.** `expand_spoken_emoji(text) -> text`

Off by default. Alias table: `../data/emoji_aliases.json` (182 phrases, 77
symbols). Multi-word phrases are stored space separated.

### Grammar

An alias phrase followed by a trailing keyword close to the word "emoji".

The keyword is **mandatory**. That single constraint is what makes the stage safe:
without it, every occurrence of "happy", "fire" or "heart" becomes a candidate.

### Algorithm

Tokenise with `(?u)[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*`, keeping each token's byte
offsets. Copy the original text through verbatim except where a match is
replaced, so all punctuation and spacing outside a match survives untouched.

Walk tokens left to right. For token `t` at index `k`:

1. Skip if `t` starts before `copied_until` (already consumed).
2. Skip unless `t` is an **emoji keyword**: lowercased length in `4..=7`
   **and** `damerau_levenshtein(lowercased, "emoji") <= 1`. This admits "emoji",
   "emogi", "emojy", "emoj"; it rejects "emojiology", which is why
   "The fire alarm has an emojiology label." is left alone.
3. Look backwards for an alias (below). No alias found, no replacement.
4. On success: emit `text[copied_until .. alias_start]`, then the symbol; set
   `copied_until = t.end`.

Finally emit `text[copied_until ..]`. If nothing changed, return the input
unchanged (identical string, not a rebuilt copy).

### Backward alias search

Consider windows of 1 to `min(k, 5)` tokens immediately before the keyword.

Every window MUST pass the **soft separator** check: the text between each
adjacent token pair in the window (keyword included) may contain only whitespace,
`-`, or `,`. This admits "thumbs-up emoji" and "HAPPY, EMOJI" while blocking
"I feel happy. Emoji are useful.", because a sentence-ending period is a hard
boundary.

**Exact pass, longest window first.** Lowercase and space-join the window; if it
equals an alias phrase, match. Longest first is what makes "red heart emoji"
produce ❤️ rather than matching the "heart" suffix.

**Fuzzy pass, only if no exact match.** For each window, shortest first:

- Let `compact_len` be the window length ignoring whitespace. Skip if
  `compact_len < 5`. Short words are too easy to confuse, which is why "bad
  emoji" stays "bad emoji" rather than becoming 😢.
- `max_edits = 2` if `compact_len >= 12` else `1`.
- Compare only against aliases with the **same word count** as the window.
- Skip if `damerau_levenshtein > max_edits`, or if
  `normalized_damerau_levenshtein < 0.80`.
- Track the best score. When a competing candidate maps to a **different**
  symbol, record it as runner-up.
- **Ambiguity veto:** accept only if there was no runner-up, or
  `best - runner_up >= 0.08`. A tie between two different emoji resolves to no
  change.

The table also carries a few explicit ASR spellings ("hapy", "hart", "fier")
precisely because those words are shorter than the fuzzy floor.

## 5. User replacement rules

**Purpose.** The user's own ordered find/replace list. Runs last, so it is the
final authority over both the recogniser and the model.

**Signature.** `apply_replacements(text, rules) -> text`

Off by default; a rule is a record:

| Field | Type | Default | Meaning |
|---|---|---|---|
| `search` | string | required | literal text, or a regex when `is_regex` |
| `replace` | string | required | replacement template, see tokens below |
| `is_regex` | bool | `false` | treat `search` as a regex |
| `enabled` | bool | `true` | disabled rules are kept but skipped |
| `trim_before` | bool | `false` | also consume whitespace before each match |
| `trim_after` | bool | `false` | also consume whitespace after each match |
| `capitalization` | enum | `none` | `none` / `uppercase` / `lowercase` / `capitalize` |

### Application

Rules apply **in order**, each seeing the previous rule's output. `[{a->b}, {b->c}]`
turns "a" into "c". This is a documented consequence, not a bug: order gives the
user layering, and it also means a careless pair of rules can loop a value
forward. Present rules to the user in an order they control.

Per rule:

1. Skip if `!enabled` or `search` is empty.
2. `core = search` when `is_regex`, else `regex_escape(search)`. Escaping is what
   makes the literal `"(c)"` match `(c)` rather than a capture group.
3. `pattern = (trim_before ? "\s*" : "") + "(?:" + core + ")" + (trim_after ? "\s*" : "")`.
   The `(?:...)` wrapper keeps an alternation in a user regex from binding
   loosely against the trim padding. Because the padding is inside the match, it
   is consumed: `trim_before` on `,` turns "hello , world" into "hello, world".
4. If the pattern fails to compile, log a warning and **skip that rule only**.
5. Expand the replacement template once, before matching.
6. Replace all matches **literally**. `$1` in the replacement MUST be inserted
   verbatim, never as a capture reference. In most regex libraries this needs an
   explicit no-expand call or manual escaping of `$`/`\`.

### Replacement template tokens

Detect and strip transform tokens first, then expand value tokens, then apply the
recorded transforms, then apply the `capitalization` field last. Transform tokens
act on the whole rule output regardless of where they appear in the template.

| Token | Effect |
|---|---|
| `[date]` | local date, `YYYY-MM-DD` |
| `[time]` | local time, `HH:MM` |
| `[uppercase]`, `[upper]` | uppercase the output |
| `[lowercase]`, `[lower]` | lowercase the output |
| `[capitalize]` | uppercase the first character only |
| `[nospace]` | drop all whitespace |

Order within step 3: lowercase, then uppercase, then capitalize, then nospace.
Then `capitalization`. `[date]` and `[time]` are the only impurity in the whole
pipeline; if you need byte-reproducible output, inject the clock.

## Conformance

`../conformance/cases.json` holds every case from the Rust test suite, plus cases
covering the Soundex variant and accented input, as fixed input/output pairs
grouped by stage. A port is conformant when it reproduces every expected output
byte for byte. Run stages in isolation, not as a pipeline.

Add cases when you add behaviour. Do not delete a case to make a port pass.

Two cases pin behaviour that is arguably wrong rather than right, because it is
what the shipped code does. Where this document and the vendored Rust disagree, and
what the ports found, see `../NOTES.md`.
