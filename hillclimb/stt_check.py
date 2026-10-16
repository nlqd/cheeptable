#!/usr/bin/env python3
"""How well does the row-number column come out?  stt_check.py ROWS.json [N]
Rows are matched to 1..N in document order (golden numbering is unique and sequential)."""
import difflib
import json
import sys

rows = json.load(open(sys.argv[1]))
n = int(sys.argv[2]) if len(sys.argv) > 2 else 473
data = [r for r in rows if r["cells"][0]["value"].strip().isdigit() and (r["cells"][3]["value"].strip() or r["cells"][-1]["value"].strip())
        and len(r["cells"][0]["value"].strip()) <= 3]
got = [int(r["cells"][0]["value"]) for r in data]
sm = difflib.SequenceMatcher(None, list(range(1, n + 1)), got, autojunk=False)
ok = sum(b.size for b in sm.get_matching_blocks())
print("STT in order %d/%d | extra rows %d | rows total %d" % (ok, n, max(len(got) - ok, 0), len(got)))
