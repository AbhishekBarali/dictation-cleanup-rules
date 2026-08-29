"""Command line entry point: run the four table stages over one string.

    python -m cleanup "So uhm I was thinking about this"
    python -m cleanup --lang pt "um gato bonito"
    python -m cleanup --vocab ChargeBee --vocab OpenAI "Charge B and Open AI"
    python -m cleanup --emoji "That worked fire emoji"

Stage 3 is a language model and is not part of this repository, so this runs
stages 1, 2, 4 and 5 only. Stage 5 has no rules to run from the command line;
pass rules through `apply_replacements` in your own code.
"""

from __future__ import annotations

import argparse
import sys

from cleanup import apply_vocabulary, expand_spoken_emoji, filter_transcript


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m cleanup",
        description="Deterministic dictation cleanup, stages 1, 2 and 4.",
    )
    parser.add_argument("text", help="the transcript to clean")
    parser.add_argument(
        "--lang",
        default="en",
        help="language code for the filler table, for example en or pt-BR",
    )
    parser.add_argument(
        "--vocab",
        action="append",
        default=[],
        metavar="WORD",
        help="a vocabulary spelling; repeat the flag for more than one",
    )
    parser.add_argument(
        "--emoji",
        action="store_true",
        help="also run spoken emoji expansion (off by default)",
    )
    args = parser.parse_args(argv)

    text = apply_vocabulary(args.text, args.vocab)
    text = filter_transcript(text, args.lang)
    if args.emoji:
        text = expand_spoken_emoji(text)

    print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
