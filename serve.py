"""Local server for the SignSense MVP. Run: py serve.py"""

from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote, urlsplit
import json
import os
import re
import sys
import threading

MODEL_REPO = Path(os.environ.get('SIGNSENSE_MODEL_REPO', Path(__file__).resolve().parent.parent / 'Modeltraining')).resolve()
sys.path.insert(0, str(MODEL_REPO / 'scripts'))
INFERENCE_LOCK = threading.Lock()
PREDICTOR = None
MAX_UPLOAD = 12 * 1024 * 1024

ROOT_DIR = Path(__file__).resolve().parent
DYNAMIC_SIGNS_DIR = ROOT_DIR / "SignSense" / "Main files" / "dynamic_signs"
LETTER_DIR = DYNAMIC_SIGNS_DIR.parent / 'letter_signs'


def letter_catalog():
    config = json.loads((MODEL_REPO / 'models/letters_three_signers/inference_config.json').read_text())
    references = {}
    for path in sorted(LETTER_DIR.glob('reference_*.jpg')):
        match = re.fullmatch(r'reference_([A-Z])_\1_\d+\.jpg', path.name)
        if match and match[1] in config['class_names']:
            references.setdefault(match[1], []).append('/SignSense/Main%20files/letter_signs/' + quote(path.name))
    return dict(letters=[dict(letter=letter, images=images) for letter, images in references.items()],
                window_seconds=config['window_seconds'], model_version='letters_three_signers')


def label_from_filename(path: Path) -> str:
    return path.stem.replace("_", " ").replace("-", " ").upper()


class SignSenseHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT_DIR), **kwargs)

    def setup(self):
        super().setup()
        self.connection.settimeout(30)

    def respond(self, status, value):
        payload = json.dumps(value).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(payload)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.end_headers()
        self.wfile.write(payload)

    def do_POST(self):
        global PREDICTOR
        if self.path != '/api/letter-attempt':
            self.respond(404, {'error': 'Unknown endpoint.'})
            return
        origin = self.headers.get('Origin')
        if origin and urlsplit(origin).netloc != self.headers.get('Host'):
            self.respond(403, {'error': 'Use the exercise from this server.'})
            return
        if self.headers.get('Content-Type', '').split(';')[0] != 'application/json':
            self.respond(415, {'error': 'Expected application/json.'})
            return
        try:
            length = int(self.headers.get('Content-Length', '0'))
        except ValueError:
            length = 0
        if not 0 < length <= MAX_UPLOAD:
            self.respond(413, {'error': 'Attempt is empty or exceeds the 12 MB limit.'})
            return
        if not INFERENCE_LOCK.acquire(blocking=False):
            self.respond(503, {'error': 'Another attempt is processing. Please retry shortly.'})
            return
        try:
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict):
                raise ValueError('Invalid attempt.')
            expected = body.get('letter')
            if expected not in {item['letter'] for item in letter_catalog()['letters']}:
                raise ValueError('Choose a letter from the exercise.')
            from letter_predictor import LetterPredictor, InvalidAttempt
            if PREDICTOR is None:
                PREDICTOR = LetterPredictor(MODEL_REPO / 'models/letters_three_signers',
                                           MODEL_REPO / 'models/holistic_landmarker.task',
                                           float(os.environ.get('SIGNSENSE_LETTER_THRESHOLD', '0.8')))
            result = PREDICTOR.predict(body.get('frames'), expected)
            self.respond(200, dict(result, expected_letter=expected, model_version='letters_three_signers'))
        except (ValueError, TypeError) as exc:
            self.respond(400, {'error': str(exc)})
        except Exception:
            import traceback
            traceback.print_exc()
            self.respond(503, {'error': 'Letter recognition is unavailable. Check the server terminal and model setup, then retry.'})
        finally:
            INFERENCE_LOCK.release()

    def do_GET(self):
        if self.path.split('?', 1)[0] == '/api/letters':
            try:
                self.respond(200, letter_catalog())
            except (OSError, ValueError, KeyError):
                self.respond(503, {'error': 'Letter model configuration is missing. Set SIGNSENSE_MODEL_REPO and restart the server.'})
            return
        if self.path.split("?", 1)[0] == "/api/dynamic-signs":
            videos = [{
                "name": video.name,
                "label": label_from_filename(video),
                "url": "/SignSense/Main%20files/dynamic_signs/" + quote(video.name),
                "modified": int(video.stat().st_mtime),
            } for video in sorted(DYNAMIC_SIGNS_DIR.glob("*.mp4"))]
            self.respond(200, {"videos": videos})
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
