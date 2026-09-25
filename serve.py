"""Local server for the SignSense MVP. Run: py serve.py"""

from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote
import json

ROOT_DIR = Path(__file__).resolve().parent
DYNAMIC_SIGNS_DIR = ROOT_DIR / "SignSense" / "Main files" / "dynamic_signs"


def label_from_filename(path: Path) -> str:
    return path.stem.replace("_", " ").replace("-", " ").upper()


class SignSenseHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT_DIR), **kwargs)

    def do_GET(self):
        if self.path.split("?", 1)[0] == "/api/dynamic-signs":
            videos = [{
                "name": video.name,
                "label": label_from_filename(video),
                "url": "/SignSense/Main%20files/dynamic_signs/" + quote(video.name),
                "modified": int(video.stat().st_mtime),
            } for video in sorted(DYNAMIC_SIGNS_DIR.glob("*.mp4"))]
            payload = json.dumps({"videos": videos}).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(payload)
            return
        if self.path in ("/", "/index.html"):
            self.send_response(302)
            self.send_header("Location", "/SignSense/Main%20files/index.html")
            self.end_headers()
            return
        super().do_GET()


if __name__ == "__main__":
    DYNAMIC_SIGNS_DIR.mkdir(exist_ok=True)
    server = ThreadingHTTPServer(("127.0.0.1", 8000), SignSenseHandler)
    print("SignSense running at http://localhost:8000/")
    print(f"Dynamic reference folder: {DYNAMIC_SIGNS_DIR}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping server.")
    finally:
        server.server_close()
