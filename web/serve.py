#!/usr/bin/env python3
"""Static file server with short/no-cache headers (python -m http.server caches aggressively via CF)."""
from __future__ import annotations

import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class NoCacheHandler(SimpleHTTPRequestHandler):
    def do_GET(self) -> None:
        path = (self.path or "").split("?", 1)[0]
        if path in ("/handbook", "/handbook/"):
            query = self.path.split("?", 1)[1] if "?" in (self.path or "") else ""
            self.path = "/handbook.html" + (("?" + query) if query else "")
        return super().do_GET()

    def end_headers(self) -> None:
        path = (self.path or "").split("?", 1)[0].lower()
        if path.endswith(".html") or path == "/" or path.endswith("/"):
            self.send_header("Cache-Control", "no-cache, must-revalidate")
        elif path.endswith((".js", ".css", ".mjs")):
            # Query-string bust is primary; still discourage long CF edge cache
            self.send_header("Cache-Control", "no-cache, must-revalidate")
        else:
            self.send_header("Cache-Control", "public, max-age=300")
        super().end_headers()

    def log_message(self, fmt: str, *args) -> None:
        # quieter default
        sys_stderr = __import__("sys").stderr
        sys_stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--bind", default="127.0.0.1")
    p.add_argument("--port", type=int, default=5173)
    p.add_argument("--directory", default=str(Path(__file__).resolve().parent))
    args = p.parse_args()
    handler = partial(NoCacheHandler, directory=args.directory)
    httpd = ThreadingHTTPServer((args.bind, args.port), handler)
    print(f"serving {args.directory} on http://{args.bind}:{args.port}", flush=True)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
