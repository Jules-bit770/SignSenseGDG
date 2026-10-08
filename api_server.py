"""Cloud Run API for the SignSense letter-recognition model."""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import json
import os
import re
import sys
import threading

MODEL_REPO = Path(os.environ.get('SIGNSENSE_MODEL_REPO', '/opt/model')).resolve()
sys.path.insert(0, str(MODEL_REPO / 'scripts'))
MAX_UPLOAD = 12 * 1024 * 1024
INFERENCE_LOCK = threading.Lock()
PREDICTOR = None
LETTER_DIR = Path('/app/letter_signs')


def allowed_origins():
    return {item.strip().rstrip('/') for item in os.environ.get('ALLOWED_ORIGINS', '').split(',') if item.strip()}


def letter_catalog():
    config = json.loads((MODEL_REPO / 'models/letters_three_signers/inference_config.json').read_text())
    references = {}
    for path in sorted(LETTER_DIR.glob('reference_*.jpg')):
        match = re.fullmatch(r'reference_([A-Z])_\1_\d+\.jpg', path.name)
        if match and match[1] in config['class_names']:
            references.setdefault(match[1], []).append('/assets/letter_signs/' + path.name)
    return {'letters': [{'letter': letter, 'images': images} for letter, images in references.items()],
            'window_seconds': config['window_seconds'], 'model_version': 'letters_three_signers'}


class ApiHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        print(format % args, flush=True)

    def cors_origin(self):
        origin = self.headers.get('Origin', '').rstrip('/')
        return origin if origin in allowed_origins() else None

    def send_json(self, status, value):
        payload = json.dumps(value).encode('utf-8')
        self.send_response(status)
        origin = self.cors_origin()
        if origin:
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Vary', 'Origin')
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(payload)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.end_headers()
        self.wfile.write(payload)

    def do_OPTIONS(self):
        origin = self.cors_origin()
        if not origin:
            self.send_json(403, {'error': 'Origin is not allowed.'})
            return
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', origin)
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Access-Control-Max-Age', '3600')
        self.send_header('Vary', 'Origin')
        self.end_headers()

    def do_GET(self):
        path = self.path.split('?', 1)[0]
        if path == '/healthz':
            self.send_json(200, {'ok': True})
            return
        if path != '/api/letters':
            if path.startswith('/assets/letter_signs/'):
                asset = LETTER_DIR / path.removeprefix('/assets/letter_signs/')
                if asset.is_file() and asset.suffix.lower() == '.jpg':
                    data = asset.read_bytes()
                    self.send_response(200)
                    origin = self.cors_origin()
                    if origin:
                        self.send_header('Access-Control-Allow-Origin', origin)
                        self.send_header('Vary', 'Origin')
                    self.send_header('Content-Type', 'image/jpeg')
                    self.send_header('Content-Length', str(len(data)))
                    self.send_header('Cache-Control', 'public, max-age=86400')
                    self.end_headers()
                    self.wfile.write(data)
                    return
            self.send_json(404, {'error': 'Unknown endpoint.'})
            return
        if self.headers.get('Origin') and not self.cors_origin():
            self.send_json(403, {'error': 'Origin is not allowed.'})
            return
        try:
            self.send_json(200, letter_catalog())
        except (OSError, ValueError, KeyError):
            self.send_json(503, {'error': 'Letter model configuration is unavailable.'})

    def do_POST(self):
        global PREDICTOR
        if self.path != '/api/letter-attempt':
            self.send_json(404, {'error': 'Unknown endpoint.'})
            return
        if not self.cors_origin():
            self.send_json(403, {'error': 'Origin is not allowed.'})
            return
        if self.headers.get('Content-Type', '').split(';')[0] != 'application/json':
            self.send_json(415, {'error': 'Expected application/json.'})
            return
        try:
            length = int(self.headers.get('Content-Length', '0'))
        except ValueError:
            length = 0
        if not 0 < length <= MAX_UPLOAD:
            self.send_json(413, {'error': 'Attempt is empty or exceeds the 12 MB limit.'})
            return
        if not INFERENCE_LOCK.acquire(blocking=False):
            self.send_json(503, {'error': 'Another attempt is processing. Please retry shortly.'})
            return
        try:
            body = json.loads(self.rfile.read(length))
            expected = body.get('letter') if isinstance(body, dict) else None
            if expected not in {item['letter'] for item in letter_catalog()['letters']}:
                raise ValueError('Choose a supported letter from the exercise.')
            from letter_predictor import LetterPredictor
            if PREDICTOR is None:
                PREDICTOR = LetterPredictor(MODEL_REPO / 'models/letters_three_signers',
                                            MODEL_REPO / 'models/holistic_landmarker.task',
                                            float(os.environ.get('SIGNSENSE_LETTER_THRESHOLD', '0.8')))
            result = PREDICTOR.predict(body.get('frames'), expected)
            self.send_json(200, dict(result, expected_letter=expected, model_version='letters_three_signers'))
        except (ValueError, TypeError) as exc:
            self.send_json(400, {'error': str(exc)})
        except Exception:
            import traceback
            traceback.print_exc()
            self.send_json(503, {'error': 'Letter recognition is temporarily unavailable. Please retry.'})
        finally:
            INFERENCE_LOCK.release()


if __name__ == '__main__':
    port = int(os.environ.get('PORT', '8080'))
    print(f'SignSense model API listening on port {port}', flush=True)
    ThreadingHTTPServer(('0.0.0.0', port), ApiHandler).serve_forever()
