#!/usr/bin/env python3
"""Serve the Night Sky app locally with caching disabled, so edits show up on reload.

Usage: python3 serve.py [port] [--lan]   (default 8000), then open http://localhost:<port>/
       --lan also serves on your local network (e.g. to try it on a phone on the same Wi-Fi).
"""
import functools
import http.server
import os
import socket
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


def lan_ip():
    """This machine's address on the local network (no packets are sent)."""
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        try:
            s.connect(("192.168.0.1", 9))
            return s.getsockname()[0]
        except OSError:
            return "127.0.0.1"


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    lan = "--lan" in sys.argv  # also listen on the local network, e.g. to open it on a phone
    port = int(args[0]) if args else 8000
    root = os.path.dirname(os.path.abspath(__file__))
    handler = functools.partial(NoCacheHandler, directory=root)
    host = "0.0.0.0" if lan else "127.0.0.1"
    with http.server.ThreadingHTTPServer((host, port), handler) as httpd:
        print(f"Night Sky: http://localhost:{port}/")
        if lan:
            print(f"  on your phone (same Wi-Fi): http://{lan_ip()}:{port}/")
            print("  note: over plain http phones won't share GPS; the app falls back to an approximate location")
        httpd.serve_forever()


if __name__ == "__main__":
    main()
