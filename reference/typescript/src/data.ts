/**
 * Loads the shared pattern tables from the repository's data directory.
 *
 * Paths are resolved relative to THIS MODULE, never relative to the process
 * working directory, so importing the library from anywhere still finds the
 * tables. From src/ the data directory is ../../../data; from a compiled dist/
 * it is one level deeper, so both are tried.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { EmojiAlias } from './types.js';

const moduleDir = dirname(fileURLToPath(import.meta.url));

function findDataDir(): string {
  const candidates = [
    resolve(moduleDir, '..', '..', '..', 'data'),
    resolve(moduleDir, '..', '..', '..', '..', 'data'),
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'filler_words.json'))) return candidate;
  }
  throw new Error(
    `could not locate the data directory, looked in: ${candidates.join(', ')}`,
  );
}

function loadJson<T>(name: string): T {
  return JSON.parse(readFileSync(join(findDataDir(), name), 'utf8')) as T;
}

/** Per-language filler word lists, plus the conservative "*" fallback. */
export const FILLER_WORDS: Readonly<Record<string, readonly string[]>> =
  loadJson<Record<string, string[]>>('filler_words.json');

/** Spoken emoji aliases, in table order. Order matters for fuzzy tie-breaks. */
export const EMOJI_ALIASES: readonly EmojiAlias[] =
  loadJson<EmojiAlias[]>('emoji_aliases.json');

/**
 * Filler list for a language code. The code is taken up to the first "-" or
 * "_", so "pt-BR" resolves as "pt". An unknown code uses the "*" entry, which
 * deliberately omits "um", "eh" and "ha" because those are real words in other
 * languages.
 */
export function fillerWordsForLanguage(lang: string): readonly string[] {
  const base = lang.split(/[-_]/)[0] ?? lang;
  return FILLER_WORDS[base] ?? FILLER_WORDS['*'] ?? [];
}
