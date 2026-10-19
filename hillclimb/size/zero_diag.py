#!/usr/bin/env python3
"""Why did the app read nothing from a table page?  size/zero_diag.py OUT.jsonl [--lane I --lanes K]   (run from hillclimb/)
Re-reads each such page picture with the current code and keeps the app's own log of it."""
import glob, json, os, subprocess, sys
a = sys.argv
opt = lambda k, d: type(d)(a[a.index(k) + 1]) if k in a else d
out, lane, lanes = a[1], opt("--lane", 0), opt("--lanes", 1)
port, BASE = 9340 + lane, "http://localhost:8080"
table = {(json.loads(l)["id"], json.loads(l)["page"]) for f in glob.glob("size/ab_istable_lane*.jsonl") for l in open(f) if (json.loads(l)["pdf_rows"] or 0) > 0}
zero = sorted((r["id"], r["page"]) for f in glob.glob("size/ab_all_lane*.jsonl") for l in open(f) for r in [json.loads(l)]
              if r["student_words"] == 0 and r["layer_words"] >= 15 and (r["id"], r["page"]) in table)
done = {(json.loads(l)["id"], json.loads(l)["page"]) for l in open(out)} if os.path.exists(out) else set()
for i, (doc, page) in enumerate(zero):
    if i % lanes != lane or (doc, page) in done:
        continue
    png, res = f"size/aball/{doc}_p{page}.png", f"size/aball/{doc}_p{page}.diag.json"
    if os.path.exists(res):
        os.remove(res)
    subprocess.run(["python3", "ux/e2e.py", BASE + "/docs/index.html", png, res, "--port", str(port), "--models", BASE + "/hillclimb/size/hosted"], capture_output=True, text=True, timeout=300)
    rows = json.load(open(res)) if os.path.exists(res) else None
    logs = subprocess.run(["rodney", "js", "JSON.stringify(CT.logs.map(l=>l.msg))"], capture_output=True, text=True, env={**os.environ}).stdout.strip()
    try:
        logs = json.loads(json.loads(logs) if logs.startswith('"') else logs)
    except Exception:
        logs = [logs[:300]]
    rec = {"id": doc, "page": page, "rows": None if not isinstance(rows, list) else len(rows), "log": logs}
    open(out, "a").write(json.dumps(rec, ensure_ascii=False) + "\n")
