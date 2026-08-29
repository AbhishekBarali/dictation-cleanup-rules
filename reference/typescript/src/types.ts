/**
 * Shared types for the deterministic cleanup stages.
 */

/** Per-rule casing transform applied last, after every replacement token. */
export type Capitalization = 'none' | 'uppercase' | 'lowercase' | 'capitalize';

/** One user find/replace rule (stage 5). */
export interface Replacement {
  /** Literal text, or a regex source when isRegex is true. Required. */
  search: string;
  /** Replacement template. Inserted literally, see applyReplacements. Required. */
  replace: string;
  /** Treat search as a regular expression. Default false. */
  isRegex?: boolean;
  /** Disabled rules are kept but skipped. Default true. */
  enabled?: boolean;
  /** Also consume whitespace before each match. Default false. */
  trimBefore?: boolean;
  /** Also consume whitespace after each match. Default false. */
  trimAfter?: boolean;
  /** Casing transform applied last. Default 'none'. */
  capitalization?: Capitalization;
}

/** One spoken emoji alias (stage 4). */
export interface EmojiAlias {
  /** Space separated lowercase phrase. */
  phrase: string;
  /** The symbol to emit, verbatim. */
  symbol: string;
}

/**
 * The three-valued filler configuration for stage 2.
 *
 * undefined or null means "use the built-in list for lang".
 * A non-empty array means "use this list instead".
 * An EMPTY array means filtering is off.
 *
 * Never test this value for truthiness: [] is truthy in JavaScript, and
 * collapsing empty into absent silently re-enables the pass.
 */
export type FillerConfig = readonly string[] | null | undefined;
