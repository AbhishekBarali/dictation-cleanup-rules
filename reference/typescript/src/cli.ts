#!/usr/bin/env node
/**
 * Tiny CLI over the deterministic stages. Runs 1, 2, 4 and 5 in order and
 * prints the result. Stage 3 is a language model and is not part of this
 * package.
 *
 *   cleanup [options] "text to clean"
 *   echo "text to clean" | cleanup [options]
 *
 *   --lang <code>      language for the filler table, default "en"
 *   --vocab <a,b,c>    comma separated vocabulary for stage 1
 *   --emoji            enable spoken emoji expansion
 *   --threshold <n>    vocabulary distance ceiling, default 0.18
 */

import { readFileSync } from 'node:fs';

import {
  applyReplacements,
  applyVocabulary,
  expandSpokenEmoji,
  filterTranscript,
} from './cleanup.js';

interface Options {
  lang: string;
  vocabulary: string[];
  emoji: boolean;
  threshold: number;
  text: string;
}

function parseArgs(argv: readonly string[]): Options {
  const options: Options = {
    lang: 'en',
    vocabulary: [],
    emoji: false,
    threshold: 0.18,
    text: '',
  };
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    switch (arg) {
      case '--lang':
        i += 1;
        options.lang = (argv[i] as string | undefined) ?? 'en';
        break;
      case '--vocab':
        i += 1;
        options.vocabulary = ((argv[i] as string | undefined) ?? '')
          .split(',')
          .map((w) => w.trim())
          .filter((w) => w.length > 0);
        break;
      case '--threshold': {
        i += 1;
        const parsed = Number.parseFloat((argv[i] as string | undefined) ?? '');
        if (Number.isFinite(parsed)) options.threshold = parsed;
        break;
      }
      case '--emoji':
        options.emoji = true;
        break;
      default:
        positional.push(arg);
        break;
    }
  }

  options.text = positional.join(' ');
  return options;
}

function readStdin(): string {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const input = options.text !== '' ? options.text : readStdin();

  // Stage 1, skipped when there is no vocabulary.
  let text = applyVocabulary(input, options.vocabulary, options.threshold);

  // Stage 2.
  text = filterTranscript(text, options.lang, null);

  // Stage 3 would go here. It is allowed to fail, and its output is advisory.

  // Stage 4, opt-in.
  if (options.emoji) text = expandSpokenEmoji(text);

  // Stage 5. No rules configured on the command line, so this is a no-op that
  // documents the order.
  text = applyReplacements(text, []);

  process.stdout.write(`${text}\n`);
}

main();
