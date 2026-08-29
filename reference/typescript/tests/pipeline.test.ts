/**
 * Integration tests for the properties the conformance suite cannot express as
 * a single stage: order, bad config tolerance, and the three-valued filler
 * configuration.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  applyReplacements,
  applyVocabulary,
  expandSpokenEmoji,
  filterTranscript,
} from '../src/cleanup.js';
import type { Replacement } from '../src/types.js';

/** Stages 1, 2, 4 and 5 in the normative order, with no model in the middle. */
function pipeline(
  text: string,
  options: {
    vocabulary?: string[];
    lang?: string;
    emoji?: boolean;
    rules?: Replacement[];
  } = {},
): string {
  let out = applyVocabulary(text, options.vocabulary ?? []);
  out = filterTranscript(out, options.lang ?? 'en', null);
  if (options.emoji === true) out = expandSpokenEmoji(out);
  return applyReplacements(out, options.rules ?? []);
}

describe('pipeline', () => {
  it('leaves an already clean sentence identical', () => {
    const text = 'The deposit is $300 and the meeting is at 9:30.';
    expect(pipeline(text)).toBe(text);
  });

  it('is a no-op end to end when nothing is configured', () => {
    const text = 'Ship the release notes before Friday.';
    expect(pipeline(text, { emoji: true })).toBe(text);
  });

  it('runs the stages in order, so rules win over earlier stages', () => {
    const out = pipeline('uhm the chargebee invoice', {
      vocabulary: ['ChargeBee'],
      rules: [{ search: 'invoice', replace: 'receipt' }],
    });
    expect(out).toBe('the ChargeBee receipt');
  });

  it('skips an invalid user regex without aborting the other rules', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const rules: Replacement[] = [
      { search: '(unclosed', replace: 'x', isRegex: true },
      { search: 'teh', replace: 'the' },
      { search: '[a-', replace: 'y', isRegex: true },
      { search: 'cat', replace: 'dog' },
    ];

    expect(applyReplacements('teh cat', rules)).toBe('the dog');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('inserts a replacement literally, so $1 and $& stay as written', () => {
    const rules: Replacement[] = [{ search: 'price', replace: '$1 $& $`' }];
    expect(applyReplacements('the price', rules)).toBe('the $1 $& $`');
  });

  describe('three-valued filler config', () => {
    const text = 'So uhm I was thinking uh about this';

    it('uses the language default when the list is undefined', () => {
      expect(filterTranscript(text, 'en')).toBe('So I was thinking about this');
    });

    it('uses the language default when the list is null', () => {
      expect(filterTranscript(text, 'en', null)).toBe('So I was thinking about this');
    });

    it('DISABLES filtering when the list is empty, even though [] is truthy', () => {
      expect(filterTranscript(text, 'en', [])).toBe(text);
    });

    it('replaces the language default when the list is non-empty', () => {
      // "uhm" and "uh" are no longer fillers, "so" now is.
      expect(filterTranscript(text, 'en', ['so'])).toBe('uhm I was thinking uh about this');
    });
  });

  it('carries stage 2 text into stages 4 and 5 when the model is absent', () => {
    // Simulates a stage 3 that timed out and returned nothing.
    const stage2 = filterTranscript('uhm that worked fire emoji', 'en', null);
    const modelOutput: string | undefined = undefined;
    const carried = modelOutput ?? stage2;
    expect(expandSpokenEmoji(carried)).toBe('that worked 🔥');
  });
});
