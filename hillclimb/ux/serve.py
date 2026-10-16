#!/usr/bin/env python3
"""Static server for the repo root with gzip for text assets (like GitHub Pages), so transferred sizes are realistic. serve.py [PORT]"""
import gzip, os, sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
TEXT = (".html", ".js", ".css", ".json", ".svg", ".xml", ".txt", ".mjs")


class H(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    def do_GET(self):
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
