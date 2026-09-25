"""Local integration smoke test: python test_letters.py (requires Playwright Chromium)."""
import base64
import json
from pathlib import Path
import threading
import urllib.error
import urllib.request

import serve


def main():
    from playwright.sync_api import sync_playwright
    server = serve.ThreadingHTTPServer(('127.0.0.1', 0), serve.SignSenseHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f'http://127.0.0.1:{server.server_port}'

    def request(path, body=None, headers=None):
        req = urllib.request.Request(base + path, data=json.dumps(body).encode() if body is not None else None,
                                     headers=headers or {'Content-Type': 'application/json'})
        try:
            with urllib.request.urlopen(req, timeout=120) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as error:
            return error.code, json.load(error)

    try:
        status, catalog = request('/api/letters')
        assert status == 200 and len(catalog['letters']) == 21, catalog
        assert request('/api/letter-attempt', {'letter': 'H', 'frames': []})[0] == 400
        assert request('/api/letter-attempt', {}, {'Content-Type': 'application/json', 'Origin': 'https://other.example'})[0] == 403
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True, args=['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'])
            page = browser.new_page(viewport={'width': 1440, 'height': 1100})
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.goto(base + '/SignSense/Main%20files/exercise_map.html')
            page.wait_for_function("document.querySelector('#letter-count').textContent === '0 / 21 letters'")
            page.screenshot(path=str(Path(__file__).parent / 'map-preview.png'), full_page=True)
            page.click('#letter-island')
            page.wait_for_function("document.querySelector('#round-progress').textContent.includes('/ 21')")
            page.wait_for_function("document.querySelector('#reference-image').naturalWidth > 0")
            page.screenshot(path=str(Path(__file__).parent / 'letters-preview.png'), full_page=True)
            letters = []
            for i in range(21):
                letters.append(page.locator('#letter-title').inner_text())
                if i < 20:
                    page.click('#next-button')
            assert len(set(letters)) == 21, letters
            page.click('#shuffle-button')
            page.click('#camera-button')
            page.wait_for_function("!document.querySelector('#check-button').disabled")
            captures = []

            def fake_prediction(route):
                body = route.request.post_data_json
                captures.append(body)
                letter = body['letter']
                route.fulfill(json={'status': 'match', 'detected_letter': letter, 'model_score': .95,
                                    'feedback': 'Correct! We recognised ' + letter, 'expected_letter': letter})

            page.route('**/api/letter-attempt', fake_prediction)
            page.click('#check-button')
            page.wait_for_function("document.querySelector('#result-card').dataset.status === 'match'", timeout=20000)
            assert len(captures[0]['frames']) >= 18
            assert captures[0]['frames'][-1]['timestamp_ms'] - captures[0]['frames'][0]['timestamp_ms'] >= catalog['window_seconds'] * 1000
            assert page.locator('#saved-progress').inner_text() == '1 / 21 letters recognised'
            page.unroute('**/api/letter-attempt')
            page.route('**/api/letter-attempt', lambda route: route.fulfill(json={'status': 'different_sign', 'detected_letter': 'B', 'model_score': .9, 'feedback': 'Try again.'}))
            page.click('#check-button')
            page.wait_for_function("document.querySelector('#result-card').dataset.status === 'different_sign'", timeout=20000)
            assert page.locator('#saved-progress').inner_text() == '1 / 21 letters recognised'
            page.unroute('**/api/letter-attempt')
            page.route('**/api/letter-attempt', lambda route: route.fulfill(json={'status': 'uncertain', 'detected_letter': None, 'model_score': None, 'feedback': 'Keep shoulders visible.'}))
            page.click('#check-button')
            page.wait_for_function("document.querySelector('#result-card').dataset.status === 'uncertain'", timeout=20000)
            assert page.locator('#saved-progress').inner_text() == '1 / 21 letters recognised'
            page.click('#camera-button')
            assert page.locator('#check-button').is_disabled()
            page.set_viewport_size({'width': 390, 'height': 844})
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            page.screenshot(path=str(Path(__file__).parent / 'letters-mobile-preview.png'), full_page=True)
            assert not errors, errors
            browser.close()
        print('PASS: map, 21 unique shuffled letters, photos, timed camera capture, all feedback states, progress, mobile layout; verdicts mocked in browser.')
        import cv2
        import numpy as np
        _, jpeg = cv2.imencode('.jpg', np.zeros((480, 640, 3), dtype=np.uint8))
        encoded = base64.b64encode(jpeg).decode()
        status, result = request('/api/letter-attempt', {'letter': 'A', 'frames': [dict(timestamp_ms=i * 100, jpeg=encoded) for i in range(31)]})
        assert status == 200 and result['reason_code'] == 'tracking_lost', (status, result)
        # Exercise the actual LSTM using a saved training-format tensor; this is
        # a compatibility smoke check, not an independent accuracy evaluation.
        dataset = serve.MODEL_REPO / 'data/letter_dataset/sequences_body_hands.npy'
        tensor = np.load(dataset, mmap_mode='r') if dataset.is_file() else np.zeros((1, 18, 227), dtype=np.float32)
        output = serve.PREDICTOR.model(np.asarray(tensor[:1]), training=False).numpy()
        assert output.shape == (1, 24) and np.isfinite(output).all()
        print('PASS: real Keras checkpoint, real MediaPipe blank-capture rejection, real LSTM forward pass.')
    finally:
        server.shutdown()
        server.server_close()


if __name__ == '__main__':
    main()
