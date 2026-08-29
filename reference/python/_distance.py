"""String distance metrics used by the cleanup stages.

Standard library only. These four functions exist here rather than as a
dependency because the whole point of the reference implementation is that you
can read it end to end and port it without chasing a package. Each one is the
plain textbook algorithm, written for clarity rather than speed.

All four operate on characters, not bytes, so they behave the same way for
accented text as for ASCII.
"""

__all__ = [
    "levenshtein",
    "soundex",
    "damerau_levenshtein",
    "normalized_damerau_levenshtein",
]


def levenshtein(first: str, second: str) -> int:
    """Edit distance counting insertions, deletions and substitutions.

    Stage 1 uses this to measure how far a spoken n-gram sits from a
    vocabulary entry. A transposition costs 2 here because swapping two
    characters is a delete plus an insert. That is why stage 4, which has to
    forgive transposed letters in "rokcet", uses Damerau-Levenshtein instead.

    Implemented with two rolling rows so the memory cost stays linear.
    """
    if first == second:
        return 0
    if not first:
        return len(second)
    if not second:
        return len(first)

    previous_row = list(range(len(second) + 1))
    for first_index, first_char in enumerate(first, start=1):
        # The first cell of each row is the cost of deleting everything so far.
        current_row = [first_index]
        for second_index, second_char in enumerate(second, start=1):
            cost_of_substitution = 0 if first_char == second_char else 1
            current_row.append(
                min(
                    previous_row[second_index] + 1,  # deletion
                    current_row[second_index - 1] + 1,  # insertion
                    previous_row[second_index - 1] + cost_of_substitution,
                )
            )
        previous_row = current_row

    return previous_row[-1]


# Consonant groups of the Soundex encoding. "h" and "w" get their own marker
# because they are dropped before duplicate codes collapse, while vowels are
# dropped after and so keep two equal codes apart. Every other character,
# including digits and letters outside a-z, is treated as a vowel.
_SOUNDEX_CODES = {
    "b": "1", "f": "1", "p": "1", "v": "1",
    "c": "2", "g": "2", "j": "2", "k": "2", "q": "2", "s": "2", "x": "2", "z": "2",
    "d": "3", "t": "3",
    "l": "4",
    "m": "5", "n": "5",
    "r": "6",
    "h": "9", "w": "9",
}
_SOUNDEX_VOWEL = "0"
_SOUNDEX_HW = "9"


def soundex(word: str) -> str:
    """Four character Soundex code, matching the vendored Rust exactly.

    Stage 1 treats two strings as phonetically equal when their codes are
    equal, and a phonetic hit multiplies the spelling distance by 0.3. Dictation
    errors are heard rather than typed, so "helo" and "hello" both code to h400
    and the pair survives a distance that plain spelling would reject.

    Two rules are easy to get wrong and both matter:

    - Letters with the same code that sit next to each other collapse to one
      digit.
    - "h" and "w" do not break such a run, but a vowel does.

    This is NOT textbook (NARA) Soundex, and the difference is deliberate. The
    Rust that produced the benchmark numbers calls `natural::phonetics::soundex`,
    which keeps the first character as a literal character rather than coding it.
    Textbook Soundex codes the first letter too and then drops a second letter
    that shares its code, so "sc" is S000 there and "s200" here. Matching the
    Rust matters more than matching the textbook, because the scores the
    benchmark reports came from this version. See the disagreement note in the
    README.

    Input is expected already lowercased, which is what `build_match_key`
    produces. An uppercase letter codes as a vowel here, exactly as in the Rust.
    An empty input returns the empty string.
    """
    if not word:
        return ""

    # The first character is carried through as-is; only the rest is coded.
    encoded = [word[0]] + [
        _SOUNDEX_CODES.get(character, _SOUNDEX_VOWEL) for character in word[1:]
    ]

    # Drop h and w first, so they cannot keep two equal codes apart.
    without_hw = [code for code in encoded if code != _SOUNDEX_HW]

    collapsed: list[str] = []
    for code in without_hw:
        if not collapsed or collapsed[-1] != code:
            collapsed.append(code)

    # Vowels are dropped after collapsing, which is what lets them separate two
    # equal codes instead of merging them.
    digits = [code for code in collapsed if code != _SOUNDEX_VOWEL]

    return ("".join(digits) + "0000")[:4]


def damerau_levenshtein(first: str, second: str) -> int:
    """Unrestricted Damerau-Levenshtein distance.

    Like Levenshtein but a transposition of two adjacent characters costs 1
    instead of 2. Stage 4 needs that: "rokcet" is one transposition from
    "rocket", and "emogi" is one substitution from "emoji", so a single shared
    edit budget can cover both kinds of recogniser slip.

    This is the unrestricted variant, which allows edits between the two
    transposed characters. The `last_row_for_char` table is what makes that
    possible; the restricted variant (optimal string alignment) drops it.
    """
    source = list(first)
    target = list(second)
    source_length = len(source)
    target_length = len(target)
    if source_length == 0:
        return target_length
    if target_length == 0:
        return source_length

    unreachable = source_length + target_length
    # The matrix is padded by one extra row and column so the transposition
    # lookup can point at a virtual "before the start" cell.
    distance = [[0] * (target_length + 2) for _ in range(source_length + 2)]
    distance[0][0] = unreachable
    for row in range(source_length + 1):
        distance[row + 1][0] = unreachable
        distance[row + 1][1] = row
    for column in range(target_length + 1):
        distance[0][column + 1] = unreachable
        distance[1][column + 1] = column

    last_row_for_char: dict[str, int] = {}

    for row in range(1, source_length + 1):
        last_match_column = 0
        for column in range(1, target_length + 1):
            match_row = last_row_for_char.get(target[column - 1], 0)
            match_column = last_match_column

            if source[row - 1] == target[column - 1]:
                cost_of_substitution = 0
                last_match_column = column
            else:
                cost_of_substitution = 1

            distance[row + 1][column + 1] = min(
                distance[row][column] + cost_of_substitution,
                distance[row + 1][column] + 1,  # insertion
                distance[row][column + 1] + 1,  # deletion
                distance[match_row][match_column]
                + (row - match_row - 1)
                + 1
                + (column - match_column - 1),  # transposition
            )
        last_row_for_char[source[row - 1]] = row

    return distance[source_length + 1][target_length + 1]


def normalized_damerau_levenshtein(first: str, second: str) -> float:
    """Damerau-Levenshtein scaled to 0.0 (unrelated) through 1.0 (identical).

    Stage 4's fuzzy pass compares candidates of different lengths against each
    other, so it needs a similarity that does not punish long phrases for
    being long. Two empty strings are defined as identical.
    """
    if not first and not second:
        return 1.0
    longest = max(len(first), len(second))
    return 1.0 - damerau_levenshtein(first, second) / longest
