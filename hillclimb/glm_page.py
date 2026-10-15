#!/usr/bin/env python3
"""Read one page image with GLM-OCR (llama-server on :8091). Usage: glm_page.py IMAGE.png [PROMPT]"""
import base64
import json
import sys
import time
import urllib.request

image, prompt = sys.argv[1], (sys.argv[2] if len(sys.argv) > 2 else "Table Recognition:")
b64 = base64.b64encode(open(image, "rb").read()).decode()
body = {"messages": [{"role": "user", "content": [
            {"type": "image_url", "image_url": {"url": "data:image/png;base64," + b64}},
            {"type": "text", "text": prompt}]}],
        "max_tokens": 12000, "temperature": 0}
t = time.time()
req = urllib.request.Request("http://127.0.0.1:8091/v1/chat/completions", json.dumps(body).encode(),
                             {"Content-Type": "application/json"})
r = json.load(urllib.request.urlopen(req, timeout=900))
sys.stderr.write("%.0fs, %d tokens, finish=%s\n" % (time.time() - t, r["usage"]["completion_tokens"], r["choices"][0]["finish_reason"]))
print(r["choices"][0]["message"]["content"])
