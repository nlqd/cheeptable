#!/usr/bin/env python3
"""Run det_probe.js in the app page over a list of detector settings: det_probe.py '[{"side":960,"th":0.3,"box":0.6,"unclip":2.0}, ...]'"""
import subprocess, sys, time, json

def rodney(*a, timeout=900):
    return subprocess.run(["rodney", *a], capture_output=True, text=True, timeout=timeout).stdout.strip()

rodney("connect", "localhost:9333")
rodney("open", "http://localhost:8080/docs/index.html"); time.sleep(3)
rodney("js", "Promise.all([...document.scripts].map(s => s.src).filter(u => u.startsWith(location.origin)).map(u => fetch(u, {cache: 'reload'}))).then(r => r.length)")
rodney("open", "http://localhost:8080/docs/index.html"); time.sleep(5)
rodney("js", "Object.defineProperty(navigator, 'gpu', {get: () => undefined}); 1")
rodney("js", "new Promise(res => { const s = document.createElement('script'); s.src = '/hillclimb/vendor/opencv.js'; s.onload = () => { onOpenCvReady(); res(1); }; document.head.appendChild(s); })")
for _ in range(60):
    if rodney("js", "opencvReady") == "true": break
    time.sleep(2)
print(rodney("js", "(window.__cfgs = %s, window.__cfgs.length)" % sys.argv[1]))
res = rodney("js", open("det_probe.js").read())
print(res[:600])
try:
    for r in json.loads(res): print(r)
except ValueError: pass
