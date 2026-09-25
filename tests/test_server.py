"""Unit and functional tests for SignSense server (serve.py).

Run with:
    python -m unittest discover -s tests -v
"""

from pathlib import Path
import json
import os
import tempfile
import threading
import unittest
from urllib.error import HTTPError
import urllib.request
import serve


class TestLabelFormatting(unittest.TestCase):
    """Unit tests for filename-to-label conversion."""

    def test_simple_word(self):
        self.assertEqual(serve.label_from_filename(Path("hello.mp4")), "HELLO")

    def test_underscores_and_hyphens(self):
        self.assertEqual(serve.label_from_filename(Path("how_are_you.mp4")), "HOW ARE YOU")
        self.assertEqual(serve.label_from_filename(Path("thank-you.mp4")), "THANK YOU")
        self.assertEqual(serve.label_from_filename(Path("my_sign-name.mp4")), "MY SIGN NAME")

    def test_case_insensitivity_and_extension(self):
        self.assertEqual(serve.label_from_filename(Path("Good-Morning.MP4")), "GOOD MORNING")


class TestLetterCatalogUnit(unittest.TestCase):
    """Unit tests for letter catalog discovery and config error handling."""

    def test_catalog_missing_config_raises(self):
        original_repo = serve.MODEL_REPO
        try:
            serve.MODEL_REPO = Path("/nonexistent/model/path")
            with self.assertRaises(OSError):
                serve.letter_catalog()
        finally:
            serve.MODEL_REPO = original_repo

    def test_catalog_with_mock_model_repo(self):
        original_repo = serve.MODEL_REPO
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            model_dir = temp_path / "models" / "letters_three_signers"
            model_dir.mkdir(parents=True, exist_ok=True)
            config_file = model_dir / "inference_config.json"
            config_file.write_text(json.dumps({
                "class_names": ["A", "B", "C"],
                "window_seconds": 3.0
            }))
            try:
                serve.MODEL_REPO = temp_path
                catalog = serve.letter_catalog()
                self.assertIn("letters", catalog)
                self.assertEqual(catalog["window_seconds"], 3.0)
                self.assertEqual(catalog["model_version"], "letters_three_signers")
                # Letters returned must be intersection of class_names and available images
                found_letters = [item["letter"] for item in catalog["letters"]]
                for letter in found_letters:
                    self.assertIn(letter, ["A", "B", "C"])
            finally:
                serve.MODEL_REPO = original_repo


class TestServerEndpoints(unittest.TestCase):
    """Functional tests exercising HTTP endpoints against a live local server."""

    @classmethod
    def setUpClass(cls):
        cls.server = serve.ThreadingHTTPServer(("127.0.0.1", 0), serve.SignSenseHandler)
        cls.server_thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.server_thread.start()
        cls.port = cls.server.server_port
        cls.base_url = f"http://127.0.0.1:{cls.port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def make_request(self, path, method="GET", body=None, headers=None):
        url = self.base_url + path
        data = None
        req_headers = headers or {}
        if body is not None:
            if isinstance(body, (dict, list)):
                data = json.dumps(body).encode("utf-8")
                req_headers.setdefault("Content-Type", "application/json")
            elif isinstance(body, (bytes, str)):
                data = body if isinstance(body, bytes) else body.encode("utf-8")

        req = urllib.request.Request(url, data=data, headers=req_headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=10) as response:
                payload = response.read()
                content_type = response.headers.get("Content-Type", "")
                parsed = json.loads(payload.decode("utf-8")) if "application/json" in content_type else payload
                return response.status, parsed, response.headers
        except HTTPError as err:
            payload = err.read()
            content_type = err.headers.get("Content-Type", "")
            parsed = json.loads(payload.decode("utf-8")) if "application/json" in content_type else payload
            err.close()
            return err.code, parsed, err.headers

    # --- Static File Serving & Redirects ---

    def test_root_redirect(self):
        # We use a custom opener that disables automatic redirect following
        class NoRedirectHandler(urllib.request.HTTPRedirectHandler):
            def http_error_302(self, req, fp, code, msg, headers):
                return fp

        opener = urllib.request.build_opener(NoRedirectHandler)
        req = urllib.request.Request(self.base_url + "/")
        with opener.open(req) as resp:
            self.assertEqual(resp.status, 302)
            self.assertEqual(resp.headers.get("Location"), "/SignSense/Main%20files/index.html")

    def test_static_asset_serving(self):
        status, data, headers = self.make_request("/SignSense/Main%20files/ui.css")
        self.assertEqual(status, 200)
        self.assertIn(b"--blue:", data)

    def test_static_file_not_found(self):
        status, _, _ = self.make_request("/SignSense/Main%20files/nonexistent-file-xyz.txt")
        self.assertEqual(status, 404)

    # --- Dynamic Signs API ---

    def test_dynamic_signs_list(self):
        status, data, headers = self.make_request("/api/dynamic-signs")
        self.assertEqual(status, 200)
        self.assertIn("videos", data)
        self.assertIsInstance(data["videos"], list)
        self.assertGreater(len(data["videos"]), 0)
        first = data["videos"][0]
        self.assertIn("name", first)
        self.assertIn("label", first)
        self.assertIn("url", first)
        self.assertIn("modified", first)
        self.assertTrue(first["url"].startswith("/SignSense/Main%20files/dynamic_signs/"))
        self.assertEqual(headers.get("Cache-Control"), "no-store")
        self.assertEqual(headers.get("X-Content-Type-Options"), "nosniff")

    def test_dynamic_signs_ignores_query_params(self):
        status, data, _ = self.make_request("/api/dynamic-signs?timestamp=12345")
        self.assertEqual(status, 200)
        self.assertIn("videos", data)

    # --- Letters API ---

    def test_letters_endpoint_missing_model_config_returns_503(self):
        original_repo = serve.MODEL_REPO
        try:
            serve.MODEL_REPO = Path("/nonexistent/repo")
            status, data, _ = self.make_request("/api/letters")
            self.assertEqual(status, 503)
            self.assertIn("error", data)
            self.assertIn("missing", data["error"].lower())
        finally:
            serve.MODEL_REPO = original_repo

    # --- Security & Validation: POST /api/letter-attempt ---

    def test_post_unknown_endpoint_returns_404(self):
        status, data, _ = self.make_request("/api/unknown", method="POST", body={})
        self.assertEqual(status, 404)
        self.assertIn("Unknown endpoint", data.get("error", ""))

    def test_post_origin_mismatch_returns_403(self):
        headers = {
            "Origin": "http://evil-attacker.example.com",
            "Host": f"127.0.0.1:{self.port}",
            "Content-Type": "application/json"
        }
        status, data, _ = self.make_request("/api/letter-attempt", method="POST", body={}, headers=headers)
        self.assertEqual(status, 403)
        self.assertIn("Use the exercise from this server", data.get("error", ""))

    def test_post_invalid_content_type_returns_415(self):
        headers = {
            "Content-Type": "text/plain",
            "Host": f"127.0.0.1:{self.port}"
        }
        status, data, _ = self.make_request("/api/letter-attempt", method="POST", body="plain text", headers=headers)
        self.assertEqual(status, 415)
        self.assertIn("Expected application/json", data.get("error", ""))

    def test_post_empty_body_returns_413(self):
        headers = {
            "Content-Type": "application/json",
            "Content-Length": "0"
        }
        status, data, _ = self.make_request("/api/letter-attempt", method="POST", body=b"", headers=headers)
        self.assertEqual(status, 413)
        self.assertIn("limit", data.get("error", ""))

    def test_post_body_too_large_returns_413(self):
        # Header claiming Content-Length > 12 MB
        headers = {
            "Content-Type": "application/json",
            "Content-Length": str(13 * 1024 * 1024)
        }
        status, data, _ = self.make_request("/api/letter-attempt", method="POST", body=b"{}", headers=headers)
        self.assertEqual(status, 413)

    def test_post_malformed_json_returns_400(self):
        headers = {
            "Content-Type": "application/json",
            "Host": f"127.0.0.1:{self.port}"
        }
        status, data, _ = self.make_request("/api/letter-attempt", method="POST", body="{not valid json", headers=headers)
        self.assertEqual(status, 400)

    def test_post_non_dict_json_returns_400(self):
        headers = {
            "Content-Type": "application/json",
            "Host": f"127.0.0.1:{self.port}"
        }
        status, data, _ = self.make_request("/api/letter-attempt", method="POST", body=[1, 2, 3], headers=headers)
        self.assertEqual(status, 400)

    def test_post_unsupported_letter_returns_400(self):
        headers = {
            "Content-Type": "application/json",
            "Host": f"127.0.0.1:{self.port}"
        }
        original_catalog = serve.letter_catalog
        try:
            serve.letter_catalog = lambda: {"letters": [{"letter": "A", "images": []}], "window_seconds": 3.0, "model_version": "mock"}
            status, data, _ = self.make_request("/api/letter-attempt", method="POST", body={"letter": "INVALID_LETTER", "frames": []}, headers=headers)
            self.assertEqual(status, 400)
            self.assertIn("Choose a letter from the exercise", data.get("error", ""))
        finally:
            serve.letter_catalog = original_catalog


if __name__ == "__main__":
    unittest.main()
