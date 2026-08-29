/**
 * Deterministic dictation cleanup, TypeScript port.
 *
 * Stage order is normative:
 *   1 applyVocabulary       (pre-model, skip when the ASR took a bias prompt)
 *   2 filterTranscript      (pre-model)
 *   3 language model        (not in this package, and allowed to fail)
 *   4 expandSpokenEmoji     (post-model, opt-in)
 *   5 applyReplacements     (post-model, opt-in, final authority)
 */

export {
  applyReplacements,
  applyVocabulary,
  escapeRegExp,
  expandSpokenEmoji,
  extractPunctuation,
  filterTranscript,
  preserveCasePattern,
} from './cleanup.js';

export {
  damerauLevenshtein,
  levenshtein,
  normalizedDamerauLevenshtein,
  soundex,
  soundexMatches,
} from './distance.js';

export { EMOJI_ALIASES, FILLER_WORDS, fillerWordsForLanguage } from './data.js';

export type {
  Capitalization,
  EmojiAlias,
  FillerConfig,
  Replacement,
} from './types.js';
