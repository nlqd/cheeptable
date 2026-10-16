#!/usr/bin/env python3
"""table_probe.py PDF_URL_PATH METHOD OUT.json [CHROME_PORT]   e.g. /hillclimb/tmp_tw/twins.pdf detector out.json"""
import json, subprocess, sys, time

def rodney(*a, timeout=900):
    r = subprocess.run(["rodney", *a], capture_output=True, text=True, timeout=timeout); return (r.stdout + r.stderr).strip()

pdf, method, out = sys.argv[1:4]
port = sys.argv[4] if len(sys.argv) > 4 else "9333"
rodney("connect", "localhost:" + port)
rodney("open", "http://localhost:8080/docs/index.html"); time.sleep(3)
rodney("reload", "--hard"); time.sleep(6)
for _ in range(30):
    if rodney("js", "opencvReady") == "true": break
    time.sleep(2)
rodney("js", "(window.__pdfUrl = '%s', window.__method = '%s', window.__progress = 0, 1)" % (pdf, method))
probe = open("table_probe.js").read().strip()
rodney("js", "(window.__done = null, %s.then(v => window.__done = v), 1)" % probe)
t0 = time.time()
while time.time() - t0 < 1500:
    time.sleep(3)
    v = rodney("js", "window.__done")
    if v and v != "null":
        if v.startswith("ERR"): sys.exit(v[:400])
        open(out, "w").write(v)
        print("done in %ds" % (time.time() - t0)); break
else:
    sys.exit("timeout")
