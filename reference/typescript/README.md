# Deterministic dictation cleanup, TypeScript

A port of the four deterministic cleanup stages. Zero runtime dependencies:
Levenshtein, Soundex and Damerau-Levenshtein are implemented in
`src/distance.ts`.

This is a port, not the original. The Rust source under `../../vendor/` is
authoritative, and this package is verified against the shared conformance suite
at `../../conformance/cases.json`. All 78 cases pass.

## Install

```
npm install
```

TypeScript, Vitest and the Node type definitions are the only dependencies, and
they are all dev dependencies.

## Build and test

```
npm run build      # tsc -p tsconfig.build.json, output in dist/
npm test           # vitest run, includes the conformance suite
npm run typecheck  # tsc --noEmit, strict mode
```

## Use

```ts
import {
  applyVocabulary,
  filterTranscript,
  expandSpokenEmoji,
  applyReplacements,
} from '@speakoflow/deterministic-cleanup';

// Stage 1, pre-model. Skip it if your recogniser accepts a bias prompt.
let text = applyVocabulary(asrOutput, ['ChargeBee', 'R&D'], 0.18);

// Stage 2, pre-model. undefined uses the language default, [] turns it off.
text = filterTranscript(text, 'en', undefined);

// Stage 3, your language model, optional and allowed to fail. On error or
// timeout, carry the stage 2 text forward instead of surfacing the error.
text = (await cleanupModel(text)) ?? text;

// Stage 4, post-model, opt-in.
text = expandSpokenEmoji(text);

// Stage 5, post-model, opt-in, final authority.
text = applyReplacements(text, [
  { search: 'chargebee', replace: 'ChargeBee' },
  { search: '\\s+,', replace: ',', isRegex: true },
]);
```

Stage order is normative. Stages 1 and 2 shrink and correct what the model
reads; stages 4 and 5 override what the model wrote.

## CLI

```
npm run build
node dist/cli.js --emoji --vocab ChargeBee "uhm the chargebee invoice, thumbs up emoji"
# the ChargeBee invoice, 👍

echo "So uhm I was thinking uh about this" | node dist/cli.js --lang en
# So I was thinking about this
```

Options: `--lang <code>`, `--vocab <a,b,c>`, `--emoji`, `--threshold <n>`.

## Notes for this port

- The filler configuration is three-valued and is modelled explicitly.
  `undefined` or `null` uses the language default, a non-empty array replaces
  it, an empty array turns filtering off. An empty array is truthy in
  JavaScript, so a truthiness check would silently re-enable the pass.
- Replacements are inserted through a function replacer, so `$1`, `$&` and
  ``$` `` in a user's replacement text stay as written. Passing the string
  directly to `String.replace` would expand them as capture references.
- Literal searches go through `escapeRegExp`, so a rule searching for `(c)`
  matches those three characters.
- An uncompilable user regex skips that rule only, with a `console.warn`.
- The filler word boundary uses Unicode lookarounds rather than `\b`, because
  JavaScript's `\b` is ASCII-only and would never match the German filler `äh`.
- Distance functions work over code points, not UTF-16 code units, so accented
  letters and astral characters count as one character.
