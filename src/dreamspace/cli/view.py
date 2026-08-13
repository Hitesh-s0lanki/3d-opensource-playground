#!/usr/bin/env python
"""Inspect every generated mesh in a browser, next to what produced it - and
start new ones from the same page.

    dreamspace-view                    # serve ./outputs on http://localhost:8000
    dreamspace-view --dir outputs      # explicit directory
    dreamspace-view --inputs inputs    # where the source photos live
    dreamspace-view --port 8080
    dreamspace-view --no-generate      # read-only: no running the pipeline

Serving over HTTP rather than opening a file:// page is deliberate - browsers
block a local page from fetching a local .glb as a cross-origin request, so
double-clicking an HTML file would show an empty viewport.

The page lives in viewer/index.html, the run graph is assembled in runs.py and
the pipeline is driven from jobs.py; this module wires them together and streams
bytes. It binds to 127.0.0.1 only, which matters rather more now that a POST to
it starts a subprocess.
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import webbrowser
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

from .jobs import JobRunner, store_upload
from .runs import discover

PAGE = Path(__file__).with_name("viewer") / "index.html"

# The source photos are not under the served directory, so they get their own
# mount rather than a second server.
INPUTS_PREFIX = "/_inputs/"


class Handler(SimpleHTTPRequestHandler):
    # Python's mimetypes table has no glTF entries, so these would otherwise be
    # served as application/octet-stream.
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".glb": "model/gltf-binary",
        ".gltf": "model/gltf+json",
    }

    inputs_dir: Path = Path("inputs")
    runner: JobRunner | None = None          # None when --no-generate

    def _send(self, body: bytes, content_type: str) -> None:
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        # The page polls for new results, so a cached listing would hide them.
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, payload, status: int = 200) -> None:
        body = json.dumps(payload).encode("utf-8")
        if status != 200:
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self._send(body, "application/json; charset=utf-8")

    def _send_input(self, name: str) -> None:
        """Serve one file from the inputs directory."""
        target = (self.inputs_dir / unquote(name)).resolve()
        # A URL is not allowed to walk out of the directory it addresses.
        if not target.is_file() or self.inputs_dir not in target.parents:
            self.send_error(404, "no such input")
            return
        kind = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        try:
            self._send(target.read_bytes(), kind)
        except OSError as exc:
            self.send_error(500, str(exc))

    def do_GET(self):  # noqa: N802
        path = urlparse(self.path).path

        if path in ("/", "/index.html"):
            try:
                self._send(PAGE.read_bytes(), "text/html; charset=utf-8")
            except OSError as exc:
                self.send_error(500, f"viewer page missing: {exc}")
            return

        if path == "/api/runs":
            root = Path(self.directory)
            payload = {
                "root": str(root),
                "inputs": str(self.inputs_dir),
                "can_generate": self.runner is not None,
                "runs": discover(root, self.inputs_dir),
            }
            self._json(payload)
            return

        if path == "/api/jobs":
            self._json({"jobs": self.runner.snapshot() if self.runner else []})
            return

        if path.startswith(INPUTS_PREFIX):
            self._send_input(path[len(INPUTS_PREFIX):])
            return

        super().do_GET()

    # -- starting work ------------------------------------------------------
    def do_POST(self):  # noqa: N802
        parsed = urlparse(self.path)
        path, query = parsed.path, parse_qs(parsed.query)

        if self.runner is None:
            self._json({"error": "generation is disabled (--no-generate)"}, 403)
            return

        if path == "/api/generate":
            self._start_job(query)
            return

        if path.startswith("/api/jobs/") and path.endswith("/cancel"):
            job_id = path[len("/api/jobs/"):-len("/cancel")]
            ok = self.runner.cancel(unquote(job_id))
            self._json({"cancelled": ok}, 200 if ok else 409)
            return

        self.send_error(404, "no such endpoint")

    def _start_job(self, query: dict) -> None:
        """Take an uploaded image and queue the pipeline against it.

        The body is the raw image rather than a multipart form: there is exactly
        one file and no other fields, and `fetch(url, {body: file})` sends that
        shape natively - which is a better trade than a multipart parser here.
        """
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            self._json({"error": "no image in the request body"}, 400)
            return
        data = self.rfile.read(length)

        kind = (query.get("kind") or ["object"])[0]
        filename = self.headers.get("X-Filename") or (query.get("name") or ["upload.png"])[0]
        options = {k: v[0] for k, v in query.items() if k not in ("kind", "name")}

        try:
            stored = store_upload(self.inputs_dir, unquote(filename), data)
            job = self.runner.submit(kind, stored, options)
        except ValueError as exc:
            self._json({"error": str(exc)}, 400)
            return

        self._json({"job": job.snapshot()})

    def log_message(self, *args):  # keep the console quiet
        pass


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Inspect generated meshes, and what produced them, in a browser.")
    ap.add_argument("--dir", type=Path, default=Path("outputs"))
    ap.add_argument("--inputs", type=Path,
                    help="Source images. Defaults to a sibling 'inputs' folder.")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--no-open", action="store_true")
    ap.add_argument("--no-generate", action="store_true",
                    help="Browse only. Without it, the page can upload an image "
                         "and run the pipeline on it.")
    args = ap.parse_args()

    root = args.dir.resolve()
    if not root.is_dir():
        print(f"No such directory: {root}")
        return 1
    inputs = (args.inputs.resolve() if args.inputs else root.parent / "inputs")

    runs = discover(root, inputs)
    meshes = sum(1 for r in runs if r["render"]) + \
        sum(1 for r in runs for i in r["items"] if i.get("mesh"))
    url = f"http://localhost:{args.port}"
    print(f"Serving {root}\n  {len(runs)} run(s), {meshes} mesh(es)"
          f"{'' if inputs.is_dir() else '  [no inputs/ found]'}\n"
          f"  generation {'off (--no-generate)' if args.no_generate else 'on'}"
          f" - uploads land in {inputs}\n  {url}\n\n"
          "New runs appear on their own. Ctrl+C to stop.")
    if not args.no_open:
        webbrowser.open(url)

    handler = partial(Handler, directory=str(root))
    Handler.inputs_dir = inputs
    Handler.runner = None if args.no_generate else JobRunner(root, inputs)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
