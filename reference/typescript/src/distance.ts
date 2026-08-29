/**
 * String distance and phonetic helpers. No third party runtime dependencies.
 *
 * All four functions operate on Unicode code points, not UTF-16 code units, so
 * an emoji or an accented letter counts as one character.
 */

/** Split into code points so astral characters count as one unit. */
function chars(s: string): string[] {
  return Array.from(s);
}

/**
 * Levenshtein edit distance: insertions, deletions, substitutions.
 * Used by stage 1 (vocabulary correction).
 */
export function levenshtein(a: string, b: string): number {
  const x = chars(a);
  const y = chars(b);
  if (x.length === 0) return y.length;
  if (y.length === 0) return x.length;

  // Single rolling row keeps this O(min(n, m)) in memory.
  let prev: number[] = new Array<number>(y.length + 1);
  for (let j = 0; j <= y.length; j += 1) prev[j] = j;

  const curr: number[] = new Array<number>(y.length + 1);
  for (let i = 1; i <= x.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= y.length; j += 1) {
      const cost = x[i - 1] === y[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        (prev[j] as number) + 1, // deletion
        (curr[j - 1] as number) + 1, // insertion
        (prev[j - 1] as number) + cost, // substitution
      );
    }
    prev = curr.slice();
  }

  return prev[y.length] as number;
}

/**
 * Unrestricted Damerau-Levenshtein distance: insertions, deletions,
 * substitutions and transpositions of two characters that need not be
 * adjacent in the original strings. This is the same variant strsim's
 * damerau_levenshtein implements, which is what the Rust source uses.
 * Used by stage 4 (spoken emoji).
 */
export function damerauLevenshtein(a: string, b: string): number {
  const x = chars(a);
  const y = chars(b);
  const n = x.length;
  const m = y.length;
  if (n === 0) return m;
  if (m === 0) return n;

  // Last row in which each character of the alphabet was seen.
  const lastRow = new Map<string, number>();

  // (n + 2) x (m + 2) matrix, offset by one for the sentinel border.
  const inf = n + m;
  const d: number[][] = [];
  for (let i = 0; i < n + 2; i += 1) {
    d.push(new Array<number>(m + 2).fill(0));
  }
  (d[0] as number[])[0] = inf;
  for (let j = 0; j <= m; j += 1) {
    (d[0] as number[])[j + 1] = inf;
    (d[1] as number[])[j + 1] = j;
  }
  for (let i = 0; i <= n; i += 1) {
    (d[i + 1] as number[])[0] = inf;
    (d[i + 1] as number[])[1] = i;
  }

  for (let i = 1; i <= n; i += 1) {
    let lastMatchCol = 0;
    for (let j = 1; j <= m; j += 1) {
      const lastMatchRow = lastRow.get(y[j - 1] as string) ?? 0;
      const cost = x[i - 1] === y[j - 1] ? 0 : 1;

      const substitution = ((d[i] as number[])[j] as number) + cost;
      const insertion = ((d[i + 1] as number[])[j] as number) + 1;
      const deletion = ((d[i] as number[])[j + 1] as number) + 1;
      const transposition =
        ((d[lastMatchRow] as number[])[lastMatchCol] as number) +
        (i - lastMatchRow - 1) +
        1 +
        (j - lastMatchCol - 1);

      (d[i + 1] as number[])[j + 1] = Math.min(
        substitution,
        insertion,
        deletion,
        transposition,
      );

      if (cost === 0) lastMatchCol = j;
    }
    lastRow.set(x[i - 1] as string, i);
  }

  return (d[n + 1] as number[])[m + 1] as number;
}

/**
 * Damerau-Levenshtein similarity in 0..1, where 1.0 is identical.
 * Two empty strings are defined as identical.
 */
export function normalizedDamerauLevenshtein(a: string, b: string): number {
  if (a.length === 0 && b.length === 0) return 1.0;
  const maxLen = Math.max(chars(a).length, chars(b).length);
  if (maxLen === 0) return 1.0;
  return 1.0 - damerauLevenshtein(a, b) / maxLen;
}

// Consonant groups of the Soundex encoding. h and w carry their own marker
// because they are dropped BEFORE duplicate codes collapse, while vowels are
// dropped AFTER and so keep two equal codes apart. Every other character,
// including digits and letters outside a-z, is treated as a vowel.
const SOUNDEX_CODES: Readonly<Record<string, string>> = {
  b: '1',
  f: '1',
  p: '1',
  v: '1',
  c: '2',
  g: '2',
  j: '2',
  k: '2',
  q: '2',
  s: '2',
  x: '2',
  z: '2',
  d: '3',
  t: '3',
  l: '4',
  m: '5',
  n: '5',
  r: '6',
  h: '9',
  w: '9',
};

const SOUNDEX_VOWEL = '0';
const SOUNDEX_HW = '9';

/**
 * Four character Soundex code, a direct port of the vendored Rust.
 *
 * This is NOT textbook (NARA) Soundex, and the difference is deliberate. The
 * Rust that produced the benchmark numbers calls `natural::phonetics::soundex`,
 * which carries the FIRST CHARACTER through as a literal character instead of
 * coding it. Textbook Soundex codes the first letter too and then drops a
 * following letter sharing its code, so "sc" is S000 there and "s200" here.
 * Matching the Rust matters more than matching the textbook.
 *
 * Two rules are easy to get wrong and both matter:
 * - Letters with the same code sitting next to each other collapse to one digit.
 * - h and w do not break such a run, but a vowel does.
 *
 * Characters outside a-z are NOT filtered out. They code as vowels, and if one
 * leads the string it is carried through literally, so "echargeb" and
 * "chargebee" do not collide. Filtering them would make an accented leading
 * character phonetically invisible and let stage 1 over-match across it.
 *
 * Input is expected already lowercased, which is what the match key produces.
 * An empty input returns the empty string.
 */
export function soundex(value: string): string {
  const characters = chars(value);
  if (characters.length === 0) return '';

  // The first character is carried through as-is; only the rest is coded.
  const encoded: string[] = [characters[0] as string];
  for (let i = 1; i < characters.length; i += 1) {
    encoded.push(SOUNDEX_CODES[characters[i] as string] ?? SOUNDEX_VOWEL);
  }

  // Drop h and w first, so they cannot keep two equal codes apart.
  const withoutHw = encoded.filter((code) => code !== SOUNDEX_HW);

  const collapsed: string[] = [];
  for (const code of withoutHw) {
    if (collapsed.length === 0 || collapsed[collapsed.length - 1] !== code) {
      collapsed.push(code);
    }
  }

  // Vowels are dropped after collapsing, which is what lets them separate two
  // equal codes instead of merging them.
  const digits = collapsed.filter((code) => code !== SOUNDEX_VOWEL);

  return (digits.join('') + '0000').slice(0, 4);
}

/** True when two strings share a Soundex code. Empty codes never match. */
export function soundexMatches(a: string, b: string): boolean {
  const codeA = soundex(a);
  if (codeA === '') return false;
  return codeA === soundex(b);
}
