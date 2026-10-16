#!/usr/bin/env python3
"""Run the deployed CheepTable page end to end in headless Chrome (rodney) on a PDF; dump its rows.

  fe_e2e.py PDF OUT.json [--keep-words OUT_words.json]
Serves docs/ on :8082 (start it first), drives #fileInput, waits for extractedRows, dumps JSON.
"""
import json
import os
import subprocess
import sys
import time

PDF, OUT = sys.argv[1], sys.argv[2]
MINCONF = os.environ.get("MINCONF")
URL = "http://localhost:8080/" + os.environ.get("APP", "docs") + "/index.html"  # repo root server, so /hillclimb/vendor is reachable


def rodney(*args, timeout=120):
    r = subprocess.run(["rodney", *args], capture_output=True, text=True, timeout=timeout)
    return r.stdout.strip()


def js(expr):
    return rodney("js", expr)


# Chrome is started separately with WebGPU flags: see run_chrome.sh. Plain headless has no GPU adapter and ORT then hangs.
rodney("connect", "localhost:9333")
rodney("open", URL)
time.sleep(3)
# the profile caches the page and its scripts heuristically; a hard reload picks up local edits
rodney("reload", "--hard")
time.sleep(5)
if os.environ.get("INT8_LOCAL"):
    js("ONNX_MODELS.encoderInt8 = '/hillclimb/models_out/vietocr/encoder_int8.onnx'; 1")
if os.environ.get("FAKE_CORES"):
    js("(Object.defineProperty(navigator, 'hardwareConcurrency', {get: () => %s}), 1)" % os.environ["FAKE_CORES"])
if MINCONF:
    js('window.__minConf = ' + MINCONF)
if os.environ.get("WASM"):
    js("Object.defineProperty(navigator, 'gpu', {get: () => undefined}); String(navigator.gpu)")
# docs.opencv.org answers scripted browsers with a Cloudflare challenge page, so load a pinned local copy instead.
js("new Promise(res => { const s = document.createElement('script'); s.src = '/hillclimb/vendor/opencv.js'; "
   "s.onload = () => { onOpenCvReady(); res(1); }; document.head.appendChild(s); })")
for _ in range(60):
    if js("opencvReady") == "true":
        break
    time.sleep(2)
print("grid module:", js("typeof findGrid"), end=" ")
print("opencv ready:", js("opencvReady"), "| grid module:", js("typeof findGrid"), "| pad:", js("typeof VIETOCR_PAD_PX"), flush=True)
t0 = time.time()
print(rodney("file", "#fileInput", PDF), flush=True)
last = ""
while time.time() - t0 < 3600:
    time.sleep(15)
    state = js("JSON.stringify({rows: extractedRows.length, page: currentOCRPage, total: totalPDFPages, "
               "result: !document.getElementById('resultPanel').classList.contains('hidden'), "
               "prog: document.getElementById('progressText').textContent})")
    if state != last:
        print("%4ds %s" % (time.time() - t0, state), flush=True)
        last = state
    try:
        s = json.loads(state)
    except ValueError:
        continue
    if s["result"] and s["rows"] > 0:
        break
rows = js("JSON.stringify(extractedRows)")
open(OUT, "w").write(rows)
words = js("JSON.stringify(debugData.ocrWords)")
open(OUT.replace(".json", "_words.json"), "w").write(words)
print("done in %ds, %d bytes rows, %d bytes words" % (time.time() - t0, len(rows), len(words)))
if os.environ.get("LINES_OUT"):
    open(os.environ["LINES_OUT"], "w").write(js("JSON.stringify(window.__lines)"))
