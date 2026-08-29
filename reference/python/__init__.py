"""Public API of the reference implementation.

The layout is flat on purpose (see README.md), so this re-export works whether
the directory is imported as a package or its modules are imported directly.
"""

try:  # imported as a package
    from .cleanup import (
        ReplacementRule,
        apply_replacements,
        apply_vocabulary,
        expand_spoken_emoji,
        extract_punctuation,
        filter_transcript,
        preserve_case_pattern,
    )
except ImportError:  # the directory itself is on sys.path
    from cleanup import (  # type: ignore[no-redef]
        ReplacementRule,
        apply_replacements,
        apply_vocabulary,
        expand_spoken_emoji,
        extract_punctuation,
        filter_transcript,
        preserve_case_pattern,
    )

__all__ = [
    "ReplacementRule",
    "apply_vocabulary",
    "filter_transcript",
    "expand_spoken_emoji",
    "apply_replacements",
    "preserve_case_pattern",
    "extract_punctuation",
]
