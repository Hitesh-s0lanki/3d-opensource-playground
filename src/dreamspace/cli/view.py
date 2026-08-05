#!/usr/bin/env python
"""Preview every generated mesh in a browser.

    dreamspace-view                 # serve ./outputs on http://localhost:8000
    dreamspace-view --dir outputs   # explicit directory
    dreamspace-view --port 8080

Serving over HTTP rather than opening a file:// page is deliberate - browsers
block a local page from fetching a local .glb as a cross-origin request, so
double-clicking an HTML file would show empty viewers.
"""

from __future__ import annotations

import argparse
import html
import webbrowser
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PAGE = """<!doctype html>
<html><head><meta charset="utf-8"><title>Generated meshes</title>
<script type="module"
  src="https://ajax.googleapis.com/ajax/libs/model-viewer/3.5.0/model-viewer.min.js"></script>
<style>
  :root {{ color-scheme: dark; }}
  body {{ margin:0; padding:24px; background:#0d0d10; color:#e8e8ea;
         font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif; }}
  h1 {{ font-size:18px; font-weight:600; margin:0 0 4px; }}
  p.sub {{ margin:0 0 24px; color:#8a8a94; }}
  .grid {{ display:grid; gap:18px;
           grid-template-columns:repeat(auto-fit,minmax(340px,1fr)); }}
  .card {{ background:#17171c; border:1px solid #26262e; border-radius:12px;
           overflow:hidden; }}
  .hd {{ display:flex; justify-content:space-between; align-items:baseline;
         padding:11px 14px; border-bottom:1px solid #26262e; }}
  .hd b {{ font-weight:600; }}
  .hd span {{ color:#8a8a94; font-size:12px; }}
  model-viewer {{ width:100%; height:340px; background:#0d0d10; }}
  .empty {{ color:#8a8a94; padding:40px 0; }}
</style></head>
<body>
<h1>Generated meshes</h1>
<p class="sub">{count} file(s) in <code>{where}</code> &middot; drag to orbit, scroll to zoom</p>
<div class="grid">{cards}</div>
</body></html>
"""

CARD = """<div class="card">
  <div class="hd"><b>{name}</b><span>{size:.1f} MB</span></div>
  <model-viewer src="{src}" camera-controls auto-rotate
                shadow-intensity="1" exposure="1"
                environment-image="neutral" ar></model-viewer>
</div>"""


def build_page(root: Path) -> str:
    files = sorted(root.rglob("*.glb")) + sorted(root.rglob("*.gltf"))
    if not files:
        cards = ('<p class="empty">No .glb files yet &mdash; run '
                 '<code>dreamspace-generate --image inputs\\</code> first.</p>')
    else:
        cards = "".join(
            CARD.format(
                name=html.escape(f.relative_to(root).as_posix()),
                size=f.stat().st_size / 1e6,
                src="/" + f.relative_to(root).as_posix(),
            )
            for f in files
        )
    return PAGE.format(count=len(files), where=html.escape(str(root)), cards=cards)


class Handler(SimpleHTTPRequestHandler):
    # Python's mimetypes table has no glTF entries, so these would otherwise be
    # served as application/octet-stream.
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".glb": "model/gltf-binary",
        ".gltf": "model/gltf+json",
    }

    def do_GET(self):  # noqa: N802
        if self.path in ("/", "/index.html"):
            body = build_page(Path(self.directory)).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            # Rebuild on every load so new meshes appear on refresh.
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()

    def log_message(self, *args):  # keep the console quiet
        pass


def main() -> int:
    ap = argparse.ArgumentParser(description="Preview generated meshes in a browser.")
    ap.add_argument("--dir", type=Path, default=Path("outputs"))
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--no-open", action="store_true")
    args = ap.parse_args()

    root = args.dir.resolve()
    if not root.is_dir():
        print(f"No such directory: {root}")
        return 1

    url = f"http://localhost:{args.port}"
    print(f"Serving {root}\n  {url}\n\nRefresh the page after a new run. Ctrl+C to stop.")
    if not args.no_open:
        webbrowser.open(url)

    server = ThreadingHTTPServer(("127.0.0.1", args.port),
                                 partial(Handler, directory=str(root)))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
