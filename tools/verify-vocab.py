"""Checks every entry of public/vocab/<family>.json against the real tokenizer: the text must encode to exactly
that one token ID. Needs `pip install tokenizers`. Run with -I.
A few vocabulary entries are never produced by the tokenizer (for example " I'" in the tiktoken-style ones, which
splits as " I" + "'"); --prune removes them from the file.

  python3 -I tools/verify-vocab.py <family> hf <tokenizer.json> [--prune]
"""
import json
import sys

family, kind, path = sys.argv[1:4]
prune = "--prune" in sys.argv[4:]
data = json.load(open(f"public/vocab/{family}.json"))

if kind != "hf":
    sys.exit("usage: python3 -I tools/verify-vocab.py <family> hf <tokenizer.json> [--prune]")

from tokenizers import Tokenizer

tok = Tokenizer.from_file(path)
encode = lambda s: tok.encode(s, add_special_tokens=False).ids

bad = []
total = 0
for table, prefix in (("sp", " "), ("no", "")):
    for word, id_ in data[table].items():
        total += 1
        if encode(prefix + word) != [id_]:
            bad.append((prefix + word, id_, encode(prefix + word)))
if prune and bad:
    for table in ("sp", "no"):
        prefix = " " if table == "sp" else ""
        data[table] = {w: i for w, i in data[table].items() if (prefix + w, i) not in {(b[0], b[1]) for b in bad}}
    open(f"public/vocab/{family}.json", "w").write(json.dumps(data, separators=(",", ":")) + "\n")
    print(f"{family}: pruned {len(bad)}")
    sys.exit(0)
print(f"{family}: {total} entries, {len(bad)} do not encode to their own ID")
for b in bad[:15]:
    print("  ", b)
sys.exit(1 if bad else 0)
