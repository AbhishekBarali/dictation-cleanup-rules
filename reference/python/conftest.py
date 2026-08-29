"""Puts this directory on sys.path so the flat modules import by name."""

import sys
from pathlib import Path

REFERENCE_DIR = Path(__file__).resolve().parent
if str(REFERENCE_DIR) not in sys.path:
    sys.path.insert(0, str(REFERENCE_DIR))
