#!/usr/bin/env python3
"""Run int8_probe.js in the app page on WASM: int8_probe.py /hillclimb/tmp_models/enc_dynamic.onnx"""
import json, subprocess, sys, time

def rodney(*a, timeout=900):
    return subprocess.run(["rodney", *a], capture_output=True, text=True, timeout=timeout).stdout.strip()

rodney("connect", "localhost:9333")
rodney("open", "http://localhost:8080/docs/index.html"); time.sleep(3)
rodney("js", "Promise.all([...document.scripts].map(s => s.src).filter(u => u.startsWith(location.origin)).map(u => fetch(u, {cache: 'reload'}))).then(r => r.length)")
rodney("open", "http://localhost:8080/docs/index.html"); time.sleep(5)
rodney("js", "Object.defineProperty(navigator, 'gpu', {get: () => undefined}); 1")
rodney("js", "new Promise(res => { const s = document.createElement('script'); s.src = '/hillclimb/vendor/opencv.js'; s.onload = () => { onOpenCvReady(); res(1); }; document.head.appendChild(s); })")
rodney("js", "(window.__encUrl = '%s', 1)" % sys.argv[1])
res = rodney("js", open("int8_probe.js").read())
try:
    d = json.loads(res)
    for t, a, b in zip(d["lines"], d["fp16"], d["int8"]):
        print("ref :", t); print("fp16:", a); print("int8:", b)
except ValueError:
    print(res[:500])
