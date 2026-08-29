/**
 * The four deterministic cleanup stages.
 *
 * Every function here is a pure function of (text, config). No network, no
 * randomness, no model. The only clock read anywhere is stage 5's [date] and
 * [time] tokens.
 *
 * Stage order is normative: 1 vocabulary, 2 filler and stutter, [3 model],
 * 4 spoken emoji, 5 user replacement rules.
 */

import { EMOJI_ALIASES, fillerWordsForLanguage } from './data.js';
import {
  damerauLevenshtein,
  levenshtein,
  normalizedDamerauLevenshtein,
  soundexMatches,
} from './distance.js';
import type {
  Capitalization,
  EmojiAlias,
  FillerConfig,
  Replacement,
} from './types.js';

// ---------------------------------------------------------------------------
// Shared character helpers
// ---------------------------------------------------------------------------

const ALPHANUMERIC = /[\p{L}\p{N}]/u;
const ALPHABETIC = /\p{L}/u;

function isAlphanumeric(char: string): boolean {
  return ALPHANUMERIC.test(char);
}

function isAlphabetic(char: string): boolean {
  return ALPHABETIC.test(char);
}

/** True for characters that have an uppercase identity, such as R but not 4. */
function isUpperCase(char: string): boolean {
  return char !== char.toLowerCase() && char === char.toUpperCase();
}

/** Code points, so an astral character is one unit. */
function codePoints(value: string): string[] {
  return Array.from(value);
}

/** Escape a literal string so it matches itself inside a regular expression. */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Uppercase the first character only, leaving the rest untouched. */
function capitalizeFirst(value: string): string {
  const points = codePoints(value);
  if (points.length === 0) return '';
  return (points[0] as string).toUpperCase() + points.slice(1).join('');
}

// ---------------------------------------------------------------------------
// Stage 1: vocabulary correction
// ---------------------------------------------------------------------------

/**
 * Reduce a word to its comparison key: lowercase alphanumeric characters only.
 * "R&D" becomes "rd"; "MacBook Pro" becomes "macbookpro".
 */
function buildMatchKey(word: string): string {
  return codePoints(word)
    .filter(isAlphanumeric)
    .map((c) => c.toLowerCase())
    .join('');
}

/** Concatenate the per-word keys of an n-gram, with no separator. */
function buildNgramKey(words: readonly string[]): string {
  return words.map(buildMatchKey).join('');
}

interface VocabularyKey {
  /** Index into the caller's vocabulary array, so a hit maps back to the
   * original spelling. */
  wordIndex: number;
  key: string;
}

/**
 * Keys for one vocabulary entry: the primary alphanumeric key, plus for entries
 * containing "&" an expanded key with "&" spelled out, so "R&D" also matches
 * the spoken form "R and D".
 */
function buildVocabularyKeys(word: string, wordIndex: number): VocabularyKey[] {
  const keys: VocabularyKey[] = [];
  const primary = buildMatchKey(word);
  if (primary !== '') keys.push({ wordIndex, key: primary });

  if (word.includes('&')) {
    const expanded = buildMatchKey(word.replace(/&/g, ' and '));
    if (expanded !== '' && expanded !== primary) {
      keys.push({ wordIndex, key: expanded });
    }
  }

  return keys;
}

/**
 * Preserve the case pattern of the original word when inserting a replacement.
 *
 * All uppercase original gives an uppercased replacement. An original whose
 * first character is uppercase gives the replacement with its first character
 * uppercased and the rest of the vocabulary spelling untouched, so
 * "Chargebee" still produces "ChargeBee". Anything else returns the
 * replacement verbatim.
 */
export function preserveCasePattern(original: string, replacement: string): string {
  const originalPoints = codePoints(original);

  if (originalPoints.every(isUpperCase)) {
    return replacement.toUpperCase();
  }

  const first = originalPoints[0];
  if (first !== undefined && isUpperCase(first)) {
    return capitalizeFirst(replacement);
  }

  return replacement;
}

/**
 * Split a word into its leading and trailing non-alphanumeric runs.
 * "!hello?" gives ["!", "?"]; "hello" gives ["", ""].
 */
export function extractPunctuation(word: string): [string, string] {
  const points = codePoints(word);

  let prefixEnd = 0;
  while (prefixEnd < points.length && !isAlphanumeric(points[prefixEnd] as string)) {
    prefixEnd += 1;
  }

  let suffixStart = 0;
  while (
    suffixStart < points.length &&
    !isAlphanumeric(points[points.length - 1 - suffixStart] as string)
  ) {
    suffixStart += 1;
  }

  const prefix = prefixEnd > 0 ? points.slice(0, prefixEnd).join('') : '';
  const suffix =
    suffixStart > 0 ? points.slice(points.length - suffixStart).join('') : '';

  return [prefix, suffix];
}

/**
 * Score a candidate key against every vocabulary key and return the best
 * accepted entry. Lower scores are better; ties keep the earlier candidate.
 */
function findBestMatch(
  candidate: string,
  vocabulary: readonly string[],
  vocabularyKeys: readonly VocabularyKey[],
  threshold: number,
): string | undefined {
  const candidateLength = codePoints(candidate).length;
  if (candidateLength === 0 || candidateLength > 50) return undefined;

  let bestMatch: string | undefined;
  let bestScore = Number.MAX_VALUE;

  for (const entry of vocabularyKeys) {
    const keyLength = codePoints(entry.key).length;

    // Length gate. This is the only thing stopping a long n-gram from
    // swallowing a much shorter vocabulary entry, for example "openaigpt"
    // matching "openai".
    const maxLen = Math.max(candidateLength, keyLength);
    const maxAllowedDiff = Math.max(maxLen * 0.25, 2.0);
    if (Math.abs(candidateLength - keyLength) > maxAllowedDiff) continue;

    const distance = levenshtein(candidate, entry.key);
    const levenshteinScore = maxLen > 0 ? distance / maxLen : 1.0;

    // A phonetic hit tolerates roughly three times the spelling distance,
    // because dictation errors are heard rather than typed.
    const phonetic = soundexMatches(candidate, entry.key);
    const score = phonetic ? levenshteinScore * 0.3 : levenshteinScore;

    if (score < threshold && score < bestScore) {
      bestMatch = vocabulary[entry.wordIndex];
      bestScore = score;
    }
  }

  return bestMatch;
}

/**
 * Stage 1. Recover proper nouns and jargon the recogniser rendered as ordinary
 * words, including one written word arriving as several spoken ones
 * ("Charge B" for "ChargeBee").
 *
 * Skip this stage entirely when the recogniser accepts a bias or hot-word
 * prompt: biasing the decoder beats correcting afterwards, and doing both
 * double-corrects.
 *
 * @param text the transcript
 * @param vocabulary the user's exact spellings
 * @param threshold distance ceiling, lower is stricter
 */
export function applyVocabulary(
  text: string,
  vocabulary: readonly string[],
  threshold = 0.18,
): string {
  if (vocabulary.length === 0) return text;

  const vocabularyKeys: VocabularyKey[] = vocabulary.flatMap((word, index) =>
    buildVocabularyKeys(word, index),
  );

  const words = text.split(/\s+/).filter((w) => w.length > 0);
  const result: string[] = [];
  let i = 0;

  while (i < words.length) {
    let matched = false;

    // Longest n-gram first, so "Open AI GPT" prefers OpenAI over GPT.
    for (let n = 3; n >= 1; n -= 1) {
      if (i + n > words.length) continue;

      const ngramWords = words.slice(i, i + n);
      const replacement = findBestMatch(
        buildNgramKey(ngramWords),
        vocabulary,
        vocabularyKeys,
        threshold,
      );
      if (replacement === undefined) continue;

      // The match key already dropped punctuation, so the prefix and suffix
      // restored here are the non-alphanumeric runs only. "GPT4" against
      // "GPT-4" must give "GPT-4", never "GPT-44".
      const [prefix] = extractPunctuation(ngramWords[0] as string);
      const [, suffix] = extractPunctuation(ngramWords[n - 1] as string);
      const cased = preserveCasePattern(ngramWords[0] as string, replacement);

      result.push(`${prefix}${cased}${suffix}`);
      i += n;
      matched = true;
      break;
    }

    if (!matched) {
      result.push(words[i] as string);
      i += 1;
    }
  }

  return result.join(' ');
}

// ---------------------------------------------------------------------------
// Stage 2: filler and stutter filter
// ---------------------------------------------------------------------------

/**
 * JavaScript's \b is defined over ASCII word characters, so \bäh\b never
 * matches the German filler "äh". These lookarounds reproduce the Unicode
 * word boundary the Rust regex crate uses.
 */
const WORD_BEFORE = '(?<![\\p{L}\\p{N}_])';
const WORD_AFTER = '(?![\\p{L}\\p{N}_])';

function buildFillerPatterns(words: readonly string[]): RegExp[] {
  const patterns: RegExp[] = [];
  for (const word of words) {
    const source = `${WORD_BEFORE}${escapeRegExp(word)}${WORD_AFTER}[,.]?`;
    try {
      patterns.push(new RegExp(source, 'giu'));
    } catch (error) {
      // A bad entry skips that word only, it never aborts the stage.
      console.warn(`Skipping filler word ${JSON.stringify(word)}: ${String(error)}`);
    }
  }
  return patterns;
}

/**
 * Collapse a run of three or more case-insensitively identical words to the
 * first occurrence, which keeps its original casing: "No NO no NO no" gives
 * "No". Only runs whose word is entirely alphabetic are eligible, so "1 1 1"
 * and "-- -- --" survive. Two repetitions are left alone, because "no no is
 * fine" is a real sentence and "very very good" is emphasis.
 */
function collapseStutters(text: string): string {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return text;

  const result: string[] = [];
  let i = 0;

  while (i < words.length) {
    const word = words[i] as string;
    const lower = word.toLowerCase();

    if (codePoints(lower).every(isAlphabetic)) {
      let count = 1;
      while (
        i + count < words.length &&
        (words[i + count] as string).toLowerCase() === lower
      ) {
        count += 1;
      }
      result.push(word);
      i += count >= 3 ? count : 1;
    } else {
      result.push(word);
      i += 1;
    }
  }

  return result.join(' ');
}

/**
 * Stage 2. Remove hesitation sounds and repetition artefacts.
 *
 * The filler configuration is three-valued and the distinction matters:
 *
 *   undefined or null -> use the built-in list for lang
 *   a non-empty array -> use that list instead
 *   an EMPTY array    -> filtering is off
 *
 * An empty array is truthy in JavaScript, so this must never be a truthiness
 * check. Array.isArray with a length test is the only correct form.
 *
 * This stage deletes. It MUST NOT add, reorder, or re-case any word it is not
 * deleting, and it has no notion of a sentence.
 */
export function filterTranscript(
  text: string,
  lang: string,
  customFillerWords?: FillerConfig,
): string {
  const useCustom = Array.isArray(customFillerWords);
  const words: readonly string[] = useCustom
    ? (customFillerWords as readonly string[])
    : fillerWordsForLanguage(lang);

  let filtered = text;

  // An empty custom list yields no patterns, which is exactly "filtering off"
  // for step 1. Steps 2 to 4 still run, matching the reference behaviour.
  for (const pattern of buildFillerPatterns(words)) {
    filtered = filtered.replace(pattern, '');
  }

  filtered = collapseStutters(filtered);

  // Whitespace tidying comes last, because filler removal leaves double
  // spaces behind wherever it deleted a word.
  filtered = filtered.replace(/\s{2,}/g, ' ');

  return filtered.trim();
}

// ---------------------------------------------------------------------------
// Stage 4: spoken emoji expansion
// ---------------------------------------------------------------------------

interface Token {
  start: number;
  end: number;
  text: string;
}

const MAX_ALIAS_WORDS = 5;

/**
 * Unicode aware tokeniser. The 'u' flag matters: JavaScript strings are UTF-16,
 * and the offsets recorded here are code unit offsets into the original string,
 * which is the same index space used to slice it back out.
 */
const TOKEN_RE = /[\p{L}\p{N}]+(?:['\u2019][\p{L}\p{N}]+)*/gu;

function tokenise(text: string): Token[] {
  const tokens: Token[] = [];
  for (const match of text.matchAll(TOKEN_RE)) {
    const start = match.index ?? 0;
    tokens.push({ start, end: start + match[0].length, text: match[0] });
  }
  return tokens;
}

/**
 * The trailing keyword is mandatory and fuzzy-bounded: lowercased length 4 to 7
 * and within Damerau-Levenshtein 1 of "emoji". That admits "emoji", "emogi",
 * "emojy" and "emoj"; the length bound is what rejects "emojiology".
 */
function isEmojiKeyword(word: string): boolean {
  const normalized = word.toLowerCase();
  const length = codePoints(normalized).length;
  return length >= 4 && length <= 7 && damerauLevenshtein(normalized, 'emoji') <= 1;
}

/** Lowercase and space-join a token window. */
function normalizedPhrase(tokens: readonly Token[]): string {
  return tokens.map((token) => token.text.toLowerCase()).join(' ');
}

/**
 * Every adjacent token pair in the window, keyword included, may be separated
 * only by whitespace, "-" or ",". This admits "thumbs-up emoji" and
 * "HAPPY, EMOJI" while a sentence-ending period stays a hard boundary.
 */
function hasSoftSeparators(text: string, tokens: readonly Token[]): boolean {
  for (let i = 0; i + 1 < tokens.length; i += 1) {
    const gap = text.slice((tokens[i] as Token).end, (tokens[i + 1] as Token).start);
    for (const char of gap) {
      if (!/\s/u.test(char) && char !== '-' && char !== ',') return false;
    }
  }
  return true;
}

const ALIAS_WORD_COUNTS: readonly number[] = EMOJI_ALIASES.map(
  (alias) => alias.phrase.split(/\s+/).filter((w) => w.length > 0).length,
);

/**
 * Search backwards from the keyword for an alias phrase. Returns the start
 * offset of the matched phrase and the symbol to emit.
 */
function findAliasBefore(
  text: string,
  tokens: readonly Token[],
  keywordIndex: number,
  copiedUntil: number,
): { start: number; symbol: string } | undefined {
  if (keywordIndex === 0) return undefined;

  const maxWords = Math.min(keywordIndex, MAX_ALIAS_WORDS);

  // Exact pass, LONGEST window first. This is what makes "red heart emoji"
  // produce the red heart rather than matching the "heart" suffix.
  for (let wordCount = maxWords; wordCount >= 1; wordCount -= 1) {
    const startIndex = keywordIndex - wordCount;
    const startToken = tokens[startIndex] as Token;
    if (startToken.start < copiedUntil) continue;
    if (!hasSoftSeparators(text, tokens.slice(startIndex, keywordIndex + 1))) continue;

    const candidate = normalizedPhrase(tokens.slice(startIndex, keywordIndex));
    const alias = EMOJI_ALIASES.find((entry: EmojiAlias) => entry.phrase === candidate);
    if (alias !== undefined) {
      return { start: startToken.start, symbol: alias.symbol };
    }
  }

  // Fuzzy pass, SHORTEST window first, and only when nothing matched exactly.
  let best: { startIndex: number; symbol: string; score: number } | undefined;
  let secondBestOtherSymbol = 0.0;

  for (let wordCount = 1; wordCount <= maxWords; wordCount += 1) {
    const startIndex = keywordIndex - wordCount;
    const startToken = tokens[startIndex] as Token;
    if (startToken.start < copiedUntil) continue;
    if (!hasSoftSeparators(text, tokens.slice(startIndex, keywordIndex + 1))) continue;

    const candidate = normalizedPhrase(tokens.slice(startIndex, keywordIndex));

    // Short words are too easy to confuse, which is why "bad emoji" stays as
    // written rather than becoming a crying face.
    const compactLength = codePoints(candidate).filter((c) => !/\s/u.test(c)).length;
    if (compactLength < 5) continue;

    const maxEdits = compactLength >= 12 ? 2 : 1;

    for (let a = 0; a < EMOJI_ALIASES.length; a += 1) {
      const alias = EMOJI_ALIASES[a] as EmojiAlias;
      if (ALIAS_WORD_COUNTS[a] !== wordCount) continue;
      if (damerauLevenshtein(candidate, alias.phrase) > maxEdits) continue;

      const score = normalizedDamerauLevenshtein(candidate, alias.phrase);
      if (score < 0.8) continue;

      if (best === undefined) {
        best = { startIndex, symbol: alias.symbol, score };
      } else if (alias.symbol === best.symbol) {
        if (score > best.score) best = { startIndex, symbol: alias.symbol, score };
      } else if (score > best.score) {
        // The previous best mapped to a different symbol, so it becomes the
        // runner-up for the ambiguity veto.
        secondBestOtherSymbol = Math.max(secondBestOtherSymbol, best.score);
        best = { startIndex, symbol: alias.symbol, score };
      } else {
        secondBestOtherSymbol = Math.max(secondBestOtherSymbol, score);
      }
    }
  }

  if (best === undefined) return undefined;

  // Ambiguity veto: a near tie between two different symbols is not a match.
  const unambiguous =
    secondBestOtherSymbol === 0.0 || best.score - secondBestOtherSymbol >= 0.08;
  if (!unambiguous) return undefined;

  return { start: (tokens[best.startIndex] as Token).start, symbol: best.symbol };
}

/**
 * Stage 4. Turn "thumbs up emoji" into the symbol without turning the word
 * "fire" into one. Off by default in a host application.
 *
 * Everything outside a match is copied through verbatim, so punctuation and
 * spacing survive untouched. When nothing matched, the input string is
 * returned as-is.
 */
export function expandSpokenEmoji(text: string): string {
  const tokens = tokenise(text);

  let output = '';
  let copiedUntil = 0;
  let changed = false;

  for (let k = 0; k < tokens.length; k += 1) {
    const token = tokens[k] as Token;
    if (token.start < copiedUntil || !isEmojiKeyword(token.text)) continue;

    const match = findAliasBefore(text, tokens, k, copiedUntil);
    if (match === undefined) continue;

    output += text.slice(copiedUntil, match.start);
    output += match.symbol;
    copiedUntil = token.end;
    changed = true;
  }

  if (!changed) return text;

  output += text.slice(copiedUntil);
  return output;
}

// ---------------------------------------------------------------------------
// Stage 5: user replacement rules
// ---------------------------------------------------------------------------

function applyCapitalization(value: string, mode: Capitalization): string {
  switch (mode) {
    case 'uppercase':
      return value.toUpperCase();
    case 'lowercase':
      return value.toLowerCase();
    case 'capitalize':
      return capitalizeFirst(value);
    case 'none':
    default:
      return value;
  }
}

/**
 * Expand the tokens inside a replacement template.
 *
 * Transform tokens are detected and stripped first, then the value tokens are
 * expanded, then the recorded transforms are applied in the order lowercase,
 * uppercase, capitalize, nospace, and finally the rule's capitalization field.
 * Transform tokens act on the whole rule output regardless of where they appear.
 */
function expandReplacement(template: string, capitalization: Capitalization): string {
  let working = template;

  const uppercase = working.includes('[uppercase]') || working.includes('[upper]');
  working = working.split('[uppercase]').join('').split('[upper]').join('');

  const lowercase = working.includes('[lowercase]') || working.includes('[lower]');
  working = working.split('[lowercase]').join('').split('[lower]').join('');

  const capitalize = working.includes('[capitalize]');
  working = working.split('[capitalize]').join('');

  const nospace = working.includes('[nospace]');
  working = working.split('[nospace]').join('');

  // [date] and [time] are the only impurity in the whole pipeline.
  if (working.includes('[date]') || working.includes('[time]')) {
    const now = new Date();
    const pad = (n: number): string => String(n).padStart(2, '0');
    const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    working = working.split('[date]').join(date).split('[time]').join(time);
  }

  if (lowercase) working = working.toLowerCase();
  if (uppercase) working = working.toUpperCase();
  if (capitalize) working = capitalizeFirst(working);
  if (nospace) working = working.replace(/\s+/gu, '');

  return applyCapitalization(working, capitalization);
}

/**
 * Stage 5. The user's own ordered find/replace list, which runs last and is
 * therefore the final authority over both the recogniser and the model.
 *
 * Rules apply in order, each seeing the previous rule's output, so
 * [{a->b}, {b->c}] turns "a" into "c". That is a documented consequence of
 * layering, not a bug.
 *
 * An uncompilable regex skips that rule only, with a warning. The replacement
 * is inserted literally, so "$1" stays the two characters "$1".
 */
export function applyReplacements(
  text: string,
  rules: readonly Replacement[],
): string {
  let result = text;

  for (const rule of rules) {
    const enabled = rule.enabled ?? true;
    if (!enabled || rule.search === '') continue;

    // Escaping is what makes the literal "(c)" match "(c)" rather than an
    // empty capture group.
    const core = rule.isRegex === true ? rule.search : escapeRegExp(rule.search);
    const prefix = rule.trimBefore === true ? '\\s*' : '';
    const suffix = rule.trimAfter === true ? '\\s*' : '';

    // The (?:...) wrapper keeps an alternation in a user regex from binding
    // loosely against the trim padding. The padding is inside the match, so it
    // is consumed.
    const pattern = `${prefix}(?:${core})${suffix}`;

    let regex: RegExp;
    try {
      regex = new RegExp(pattern, 'g');
    } catch (error) {
      console.warn(
        `Skipping invalid replacement rule (search=${JSON.stringify(rule.search)}): ${String(error)}`,
      );
      continue;
    }

    // Identical for every match within a rule, so expand once.
    const replacement = expandReplacement(
      rule.replace,
      rule.capitalization ?? 'none',
    );

    // A FUNCTION replacer is required. Passing the string directly would let
    // the engine expand $1, $&, $` and friends in the user's replacement.
    result = result.replace(regex, () => replacement);
  }

  return result;
}
