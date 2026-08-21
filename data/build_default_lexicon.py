"""
build_default_lexicon.py

Builds a single deduplicated profanity lexicon from three sources:

- profanity_en.csv
- en1.txt
- en2.txt

Each TXT file should contain one keyword/phrase per line.

OUTPUT
------
default_lexicon.json
    A sorted, case-insensitive deduplicated array of strings suitable for
    bundling directly into the browser extension.
"""

import csv
import json
import sys
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent
RAW_DIR = DATA_DIR / "raw"

CSV_FILE = RAW_DIR / "profanity_en.csv"
TXT_FILES = [
    RAW_DIR / "en1.txt",
    RAW_DIR / "en2.txt",
    RAW_DIR / "fil1.txt",
]

# ---------------------------------------------------------------------
# Verify files exist
# ---------------------------------------------------------------------

missing = []

for path in [CSV_FILE, *TXT_FILES]:
    if not path.exists():
        missing.append(str(path))

if missing:
    sys.exit(
        "Missing required file(s):\n"
        + "\n".join(f"  - {name}" for name in missing)
    )

# ---------------------------------------------------------------------
# Read keywords
# ---------------------------------------------------------------------

keywords = []

# CSV (Surge AI dataset)
with CSV_FILE.open(newline="", encoding="utf-8") as f:
    reader = csv.DictReader(f)

    for row in reader:
        text = (row.get("text") or "").strip()

        if text:
            keywords.append(text)

# TXT files
for txt_file in TXT_FILES:
    with txt_file.open(encoding="utf-8") as f:
        for line in f:
            word = line.strip()

            # Ignore blank lines and comments
            if not word or word.startswith("#"):
                continue

            keywords.append(word)

# ---------------------------------------------------------------------
# Deduplicate (case-insensitive, preserving first occurrence)
# ---------------------------------------------------------------------

seen = set()
unique_keywords = []

for word in keywords:
    key = word.casefold()

    if key in seen:
        continue

    seen.add(key)
    unique_keywords.append(word)

# Sort alphabetically (case-insensitive)
unique_keywords.sort(key=str.casefold)

# ---------------------------------------------------------------------
# Write output
# ---------------------------------------------------------------------

OUTPUT = DATA_DIR / "default_lexicon.json"

with OUTPUT.open("w", encoding="utf-8") as f:
    json.dump(unique_keywords, f, ensure_ascii=False, indent=2)

print(f"Loaded {len(keywords):,} total entries.")
print(f"Removed {len(keywords) - len(unique_keywords):,} duplicates.")
print(f"Wrote {len(unique_keywords):,} unique keywords to {OUTPUT}")
