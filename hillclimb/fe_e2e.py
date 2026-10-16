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
URL = os.environ.get("URL") or "http://localhost:8080/" + os.environ.get("APP", "docs") + "/index.html"  # URL=https://... tests a deployed page


def rodney(*args, timeout=120):
    r = subprocess.run(["rodney", *args], capture_output=True, text=True, timeout=timeout)
    return r.stdout.strip()


def js(expr):
    out = rodney("js", expr)
    if "SyntaxError" in out or out.startswith("error:"):
        sys.exit("harness: rodney js failed: %s  <- %s" % (out[:200], expr[:120]))   # an ignored failure once made every "int8" run use fp16
    return out


# Chrome is started separately with WebGPU flags: see run_chrome.sh. Plain headless has no GPU adapter and ORT then hangs.
rodney("connect", "localhost:" + os.environ.get("CHROME_PORT", "9333"))
rodney("open", URL)
time.sleep(3)
# the profile caches the page and its scripts heuristically; a hard reload picks up local edits
rodney("reload", "--hard")
time.sleep(5)
if os.environ.get("INT8_LOCAL"):
    js("(ONNX_MODELS.encoderInt8 = '/hillclimb/models_out/vietocr/encoder_int8.onnx', 1)")
if os.environ.get("DEC_LOCAL"):
    js("(ONNX_MODELS.decoder = '%s', 1)" % os.environ["DEC_LOCAL"])
if os.environ.get("GPU_ENC_LOCAL"):
    js("(ONNX_MODELS.encoderGpu = '%s', 1)" % os.environ["GPU_ENC_LOCAL"])
if os.environ.get("KV_LOCAL"):
    js("(ONNX_MODELS.decoderInit = '/hillclimb/models_out/vietocr/decoder_init_fp16w.onnx', ONNX_MODELS.decoderStep = '/hillclimb/models_out/vietocr/decoder_step_fp16w.onnx', 1)")
if os.environ.get("FAKE_CORES"):
    js("(Object.defineProperty(navigator, 'hardwareConcurrency', {get: () => %s}), 1)" % os.environ["FAKE_CORES"])
if os.environ.get("PHASES"):
    js("(window.__t = [], ['renderPageToCanvas', 'findGrid', 'ocrPageWithGrid', 'detectTableBorders', 'startOcrPool', 'stopOcrPool', 'ocrTableExtract', 'repairNumbering', 'repairArithmetic', 'renderPreview', 'showStats'].forEach(n => { const o = window[n]; if (typeof o !== 'function') return; window[n] = async function (...a) { const t0 = performance.now(); try { return await o.apply(this, a); } finally { window.__t.push([n, Math.round(performance.now() - t0)]); } }; }), 1)")
if os.environ.get("TRACE"):
    js("(window.__enc = [], window.__dec = [], window.__g = window._gpuEncode, window._gpuEncode = function (t) { const s = performance.now(); return window.__g(t).then(m => { window.__enc.push([Math.round(s), Math.round(performance.now())]); return m; }); }, window.__d = OcrPool.prototype.decodeMemory, OcrPool.prototype.decodeMemory = function (d, dims) { const s = performance.now(); return window.__d.call(this, d, dims).then(r => { window.__dec.push([Math.round(s), Math.round(performance.now())]); return r; }); }, 1)")
if os.environ.get("WARN"):
    js("(window.__w = [], console.warn = (...a) => window.__w.push(a.map(String).join(' ').slice(0, 400)), console.error = console.warn, 1)")
if os.environ.get("PROFILE"):
    js("(window.__reads = [], window.__orig = _recognizeBox, _recognizeBox = async (c, b) => { const r = await window.__orig(c, b); window.__reads.push(r.ms); return r; }, 1)")
if MINCONF:
    js('window.__minConf = ' + MINCONF)
if os.environ.get("WASM"):
    js("Object.defineProperty(navigator, 'gpu', {get: () => undefined}); String(navigator.gpu)")
# The page self-hosts OpenCV.js. Wait for it; only if it never loads, inject the pinned copy from vendor/.
for _ in range(30):
    if js("opencvReady") == "true":
        break
    time.sleep(2)
else:
    print("page's own OpenCV did not load; injecting vendor copy", flush=True)
    js("new Promise(res => { const s = document.createElement('script'); s.src = '/hillclimb/vendor/opencv.js'; "
       "s.onload = () => { onOpenCvReady(); res(1); }; document.head.appendChild(s); })")
    for _ in range(60):
        if js("opencvReady") == "true":
            break
        time.sleep(2)
print("opencv ready:", js("opencvReady"), "| grid module:", js("typeof findGrid"), "| pad:", js("typeof VIETOCR_PAD_PX"), flush=True)
t0 = time.time()
print(rodney("file", "#fileInput", PDF), flush=True)
last = ""
while time.time() - t0 < 3600:
    time.sleep(2)
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

if os.environ.get("PROFILE"):
    open(os.environ["PROFILE"], "w").write(js("JSON.stringify(window.__reads)"))

if os.environ.get("PHASES"):
    open(os.environ["PHASES"], "w").write(js("JSON.stringify(window.__t)"))

if os.environ.get("TRACE"):
    open(os.environ["TRACE"], "w").write(js("JSON.stringify({enc: window.__enc, dec: window.__dec})"))

if os.environ.get("WARN"):
    print("\n".join(json.loads(js("JSON.stringify(window.__w)"))[:8]))
