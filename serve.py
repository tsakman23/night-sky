#!/usr/bin/env python3
"""Serve the Night Sky app locally with caching disabled, so edits show up on reload.

Usage: python3 serve.py [port]   (default 8000), then open http://localhost:<port>/
"""
import functools
import http.server
import os
import sys


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        # Cross-origin isolation: lets the voice model use multi-threaded WebAssembly
        # (SharedArrayBuffer). Third-party requests (model, geocoding) are CORS fetches, which stay allowed.
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        super().end_headers()

    def log_message(self, fmt, *args):  # keep the terminal quiet
        pass


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    root = os.path.dirname(os.path.abspath(__file__))
    handler = functools.partial(NoCacheHandler, directory=root)
    with http.server.ThreadingHTTPServer(("127.0.0.1", port), handler) as httpd:
        print(f"Night Sky: http://localhost:{port}/")
        httpd.serve_forever()


if __name__ == "__main__":
    main()
