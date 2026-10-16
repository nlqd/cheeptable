#!/usr/bin/env python3
"""Static server for the repo root with gzip for text assets (like GitHub Pages), so transferred sizes are realistic. serve.py [PORT]"""
import gzip, json, os, sys, threading, time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
TEXT = (".html", ".js", ".css", ".json", ".svg", ".xml", ".txt", ".mjs")


FLAKY = {"cut": 0, "times": 0, "slow": 0, "count": {}, "sent": {}}   # /ctl?cut=BYTES&times=N: the first N requests per file stop after BYTES
LOCK = threading.Lock()


class H(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    def flaky(self, rel):
        path = os.path.join(ROOT, rel)
        if not os.path.isfile(path):
            self.send_error(404); return
        size = os.path.getsize(path)
        start = 0
        rng = self.headers.get("Range", "")
        if rng.startswith("bytes="):
            start = int(rng[6:].split("-")[0] or 0)
        with LOCK:
            n = FLAKY["count"][rel] = FLAKY["count"].get(rel, 0) + 1
        cut = n <= FLAKY["times"] and FLAKY["cut"] < size - start
        self.send_response(206 if start else 200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(size - start))
        self.send_header("Access-Control-Allow-Origin", "*")
        if start:
            self.send_header("Content-Range", "bytes %d-%d/%d" % (start, size - 1, size))
        self.end_headers()
        body = open(path, "rb").read()[start:]
        part = body[:FLAKY["cut"]] if cut else body
        try:
            for i in range(0, len(part), 65536):
                if FLAKY["slow"]:
                    time.sleep(FLAKY["slow"] / 1000)
                self.wfile.write(part[i:i + 65536])
                with LOCK:
                    FLAKY["sent"][rel] = FLAKY["sent"].get(rel, 0) + len(part[i:i + 65536])
            if cut:
                self.wfile.flush(); self.connection.close()      # the promised length is never delivered
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_GET(self):
        if self.path.startswith("/ctl"):
            q = dict(kv.split("=") for kv in self.path.split("?", 1)[1].split("&") if kv) if "?" in self.path else {}
            with LOCK:
                if "cut" in q: FLAKY["cut"] = int(q["cut"])
                if "times" in q: FLAKY["times"] = int(q["times"])
                if "slow" in q: FLAKY["slow"] = int(q["slow"])
                if q.get("reset"): FLAKY["count"].clear(); FLAKY["sent"].clear()
                out = json.dumps({"cut": FLAKY["cut"], "times": FLAKY["times"], "requests": FLAKY["count"], "sent": FLAKY["sent"]})
            self.send_response(200); self.send_header("Content-Type", "application/json"); self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers(); self.wfile.write(out.encode()); return
        if self.path.startswith("/flaky/"):
            self.flaky(self.path.split("?", 1)[0][len("/flaky/"):]); return
        path = self.translate_path(self.path.split("?", 1)[0])
        if os.path.isfile(path) and path.endswith(TEXT) and "gzip" in self.headers.get("Accept-Encoding", ""):
            body = gzip.compress(open(path, "rb").read(), 6)
            self.send_response(200)
            self.send_header("Content-Type", self.guess_type(path))
            self.send_header("Content-Encoding", "gzip")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            self.wfile.write(body)
        else:
            super().do_GET()

    def log_message(self, *a):
        pass


ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1]) if len(sys.argv) > 1 else 8080), H).serve_forever()
