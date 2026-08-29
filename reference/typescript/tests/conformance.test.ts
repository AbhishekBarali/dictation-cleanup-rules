/**
 * Runs the shared conformance suite from ../../../conformance/cases.json.
 *
 * Each stage is exercised in isolation, one test per case id, exactly as the
 * suite intends. Every assertion kind in the file is handled: expected,
 * expected_contains, expected_not_contains and expected_matches.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  applyReplacements,
  applyVocabulary,
  expandSpokenEmoji,
  extractPunctuation,
  filterTranscript,
  preserveCasePattern,
} from '../src/cleanup.js';
import { soundex } from '../src/distance.js';
import type { Capitalization, Replacement } from '../src/types.js';

// ---------------------------------------------------------------------------
// Suite shape
// ---------------------------------------------------------------------------

interface Assertions {
  expected?: unknown;
  expected_contains?: string[];
  expected_not_contains?: string[];
  expected_matches?: string;
}

interface BaseCase extends Assertions {
  id: string;
}

interface VocabularyCase extends BaseCase {
  text: string;
  vocabulary: string[];
  threshold: number;
}

interface CasePreservationCase extends BaseCase {
  original: string;
  replacement: string;
}

interface PunctuationCase extends BaseCase {
  word: string;
}

interface FillerCase extends BaseCase {
  text: string;
  lang: string;
  custom_filler_words: string[] | null;
}

interface EmojiCase extends BaseCase {
  text: string;
}

interface RawRule {
  search: string;
  replace: string;
  is_regex?: boolean;
  enabled?: boolean;
  trim_before?: boolean;
  trim_after?: boolean;
  capitalization?: Capitalization;
}

interface ReplacementCase extends BaseCase {
  text: string;
  rules: RawRule[];
}

interface SoundexCase extends BaseCase {
  word: string;
}

interface Suite {
  stages: {
    soundex: { cases: SoundexCase[] };
    vocabulary: { cases: VocabularyCase[] };
    case_preservation: { cases: CasePreservationCase[] };
    punctuation_split: { cases: PunctuationCase[] };
    filler_and_stutter: { cases: FillerCase[] };
    spoken_emoji: { cases: EmojiCase[] };
    replacements: { cases: ReplacementCase[] };
  };
}

const here = dirname(fileURLToPath(import.meta.url));
const suitePath = resolve(here, '..', '..', '..', 'conformance', 'cases.json');
const suite = JSON.parse(readFileSync(suitePath, 'utf8')) as Suite;

/** Applies whichever assertion kinds a case declares. */
function check(testCase: Assertions, actual: string): void {
  if (Object.prototype.hasOwnProperty.call(testCase, 'expected')) {
    expect(actual).toBe(testCase.expected as string);
  }
  for (const needle of testCase.expected_contains ?? []) {
    expect(actual).toContain(needle);
  }
  for (const needle of testCase.expected_not_contains ?? []) {
    expect(actual).not.toContain(needle);
  }
  if (testCase.expected_matches !== undefined) {
    expect(actual).toMatch(new RegExp(testCase.expected_matches));
  }
}

/** Map the suite's snake_case rule records onto the library interface. */
function toRule(raw: RawRule): Replacement {
  const rule: Replacement = { search: raw.search, replace: raw.replace };
  if (raw.is_regex !== undefined) rule.isRegex = raw.is_regex;
  if (raw.enabled !== undefined) rule.enabled = raw.enabled;
  if (raw.trim_before !== undefined) rule.trimBefore = raw.trim_before;
  if (raw.trim_after !== undefined) rule.trimAfter = raw.trim_after;
  if (raw.capitalization !== undefined) rule.capitalization = raw.capitalization;
  return rule;
}

// ---------------------------------------------------------------------------
// Stage 1 primitives
// ---------------------------------------------------------------------------

describe('stage 1 primitive: soundex', () => {
  it.each(suite.stages.soundex.cases.map((c) => [c.id, c] as const))('%s', (_id, testCase) => {
    check(testCase, soundex(testCase.word));
  });
});

// ---------------------------------------------------------------------------
// Stage 1
// ---------------------------------------------------------------------------

describe('stage 1: applyVocabulary', () => {
  it.each(suite.stages.vocabulary.cases.map((c) => [c.id, c] as const))(
    '%s',
    (_id, testCase) => {
      check(testCase, applyVocabulary(testCase.text, testCase.vocabulary, testCase.threshold));
    },
  );
});

describe('stage 1: preserveCasePattern', () => {
  it.each(suite.stages.case_preservation.cases.map((c) => [c.id, c] as const))(
    '%s',
    (_id, testCase) => {
      check(testCase, preserveCasePattern(testCase.original, testCase.replacement));
    },
  );
});

describe('stage 1: extractPunctuation', () => {
  it.each(suite.stages.punctuation_split.cases.map((c) => [c.id, c] as const))(
    '%s',
    (_id, testCase) => {
      expect(extractPunctuation(testCase.word)).toEqual(testCase.expected);
    },
  );
});

// ---------------------------------------------------------------------------
// Stage 2
// ---------------------------------------------------------------------------

describe('stage 2: filterTranscript', () => {
  it.each(suite.stages.filler_and_stutter.cases.map((c) => [c.id, c] as const))(
    '%s',
    (_id, testCase) => {
      check(
        testCase,
        filterTranscript(testCase.text, testCase.lang, testCase.custom_filler_words),
      );
    },
  );
});

// ---------------------------------------------------------------------------
// Stage 4
// ---------------------------------------------------------------------------

describe('stage 4: expandSpokenEmoji', () => {
  it.each(suite.stages.spoken_emoji.cases.map((c) => [c.id, c] as const))(
    '%s',
    (_id, testCase) => {
      check(testCase, expandSpokenEmoji(testCase.text));
    },
  );
});

// ---------------------------------------------------------------------------
// Stage 5
// ---------------------------------------------------------------------------

describe('stage 5: applyReplacements', () => {
  it.each(suite.stages.replacements.cases.map((c) => [c.id, c] as const))(
    '%s',
    (_id, testCase) => {
      check(testCase, applyReplacements(testCase.text, testCase.rules.map(toRule)));
    },
  );
});
