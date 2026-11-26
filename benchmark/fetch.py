#!/usr/bin/env python3
"""Download the benchmark corpus and write the manifests the lab scripts read.   run from anywhere:  python3 benchmark/fetch.py [--only t01,t02] [--dest DIR]
The 642 files are public documents (price lists, gazettes, statistics, syllabuses) that this repository does not carry. benchmark/sources/*.json
list each one with its address; sha256.txt holds the checksum of the copy the results were measured on. A file that downloads with another
checksum has been changed by its site since: it is kept, and listed at the end, because scores on it will differ.
Writes DEST/benchmark/manifest3_tNN.json (absolute local_path; DEST is the repository unless --dest says otherwise), which hillclimb/size/*.py glob."""
import glob, hashlib, json, os, sys, urllib.request

a = sys.argv
here = os.path.dirname(os.path.abspath(__file__))
root = os.path.dirname(here)
only = a[a.index("--only") + 1].split(",") if "--only" in a else None
dest = os.path.abspath(a[a.index("--dest") + 1]) if "--dest" in a else root
want = dict(reversed(l.split("  ", 1)) for l in open(f"{here}/sources/sha256.txt").read().splitlines())
changed, failed = [], []

for src in sorted(glob.glob(f"{here}/sources/t*.json")):
    tag = os.path.basename(src)[:-5]
    if only and tag not in only:
        continue
    entries = json.load(open(src))
    for e in entries:
        path = os.path.join(dest, e["local_path"])
        e["local_path"] = path
        if not os.path.exists(path):
            os.makedirs(os.path.dirname(path), exist_ok=True)
            try:
                req = urllib.request.Request(e["url"], headers={"User-Agent": "Mozilla/5.0 (corpus fetch for an open OCR benchmark)"})
                with urllib.request.urlopen(req, timeout=120) as r, open(path, "wb") as f:
                    f.write(r.read())
            except Exception as err:
                failed.append((e["id"], str(err)[:80]))
                continue
        rel = os.path.relpath(path, dest)
        if hashlib.sha256(open(path, "rb").read()).hexdigest() != want.get(rel):
            changed.append(e["id"])
    os.makedirs(f"{dest}/benchmark", exist_ok=True)
    json.dump(entries, open(f"{dest}/benchmark/manifest3_{tag}.json", "w"), ensure_ascii=False, indent=1)
    print(tag, len(entries), flush=True)

print(f"\nfailed to download: {len(failed)}")
for i, err in failed:
    print("  ", i, err)
print(f"checksum differs from the measured copy: {len(changed)}")
for i in changed:
    print("  ", i)
