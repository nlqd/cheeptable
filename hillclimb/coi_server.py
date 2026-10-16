#!/usr/bin/env python3
"""Serve the repo with cross-origin isolation headers (what ORT-web needs for WASM threads): coi_server.py PORT"""
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

class H(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "credentialless")
        super().end_headers()

ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
