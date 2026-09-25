# SignSense MVP

## Run the app

```powershell
py serve.py
```

Open `http://localhost:8000`, sign in or create a local demo account, then open
**Exercise 1: Dynamic Sign Practice**.

## Letter island (trained model)

Keep this repository beside `Modeltraining`, or set `SIGNSENSE_MODEL_REPO` to
the full path of that repository. Run the server with the Python environment
that has the model dependencies installed:

```powershell
cd C:\Users\mathu\Modeltraining
python -m pip install -r requirements.txt
cd C:\Users\mathu\SignSenseGDG
$env:SIGNSENSE_MODEL_REPO = 'C:\Users\mathu\Modeltraining'
python serve.py
```

Open http://localhost:8000, then select **Letter island** on the learning map.
Start the camera, copy the displayed photo, and select **Check my sign**.
After a three-second countdown, hold/perform the letter for about three seconds.
Keep shoulders and signing hands visible. The first check loads the model and
can take longer. Use **Try again**, **Next letter**, or **Shuffle a new round**.

The server uses these local assets, without copying model binaries into this repo:

- `Modeltraining/scripts/letter_predictor.py` and `sign_features.py`
- `Modeltraining/models/letters_three_signers/best_lstm_model.keras`
- `Modeltraining/models/letters_three_signers/inference_config.json`
- `Modeltraining/models/holistic_landmarker.task`

`SIGNSENSE_LETTER_THRESHOLD` optionally overrides the default 0.8 acceptance
threshold. It is an uncalibrated model score, not a technique accuracy score.
Lowering it does not improve the model. Low scores or lost tracking yield
**uncertain**, not a failed letter. A confident different letter prompts a retry.
Moving on is always allowed; matches are saved separately from word scores.

There are currently 21 letters with both model support and reference photos.
H/J have no model support; O/R/V have no reference photo in this checkout.
Add correctly named photos such as `reference_O_O_1.jpg` to include supported
missing letters. The server intersects filenames with the model's class list.
Letters are shuffled without repetition within a round; alternate photos are
available for letters with multiple images.

### Local API

- `GET /api/letters`: supported `{letter, images}` entries, `window_seconds`,
  and `model_version`.
- `POST /api/letter-attempt`: JSON `{letter: "A", frames: [{timestamp_ms: 0,
  jpeg: "<base64 JPEG without data URL prefix>"}, ...]}`. The browser sends
  approximately 10 frames/second over the configured duration. The service
  extracts landmarks from these frames and uses the shared 18-frame sampler.
- Response: `{expected_letter, detected_letter, model_score, status,
  reason_code, feedback, model_version}`. Status is `match`, `different_sign`,
  or `uncertain`. HTTP 400 means invalid capture; 503 means busy/unavailable.
- Maximum body: 12 MB; maximum 90 frames; accepted decoded size: 160x120
  through 960x720. Captures are processed in memory, one at a time. No camera
  recordings are saved. Preview mirroring does not mirror model input.

This is a **localhost prototype**, using the existing localStorage demo login
and device-only progress. The local server does not provide production
authentication or trusted assessment records. Do not expose it publicly as-is.
Hosted integration needs real backend authentication and HTTPS for camera use.
The model's familiar-signer validation accuracy does not establish accuracy
for new learners or signing technique. Test with people before using it to
grade learning outcomes.

### Verification

Model repository: `python -m unittest discover -s tests -v`.
Frontend integration: `python test_letters.py` with Playwright and its Chromium
browser installed in the development environment. This checks the map, all
shuffled photos, timed fake-camera capture, three mocked feedback states,
progress and mobile layout; it also loads the actual checkpoint, runs its LSTM,
and checks real MediaPipe rejection of a blank capture. It does not measure
recognition accuracy on human signers.

Manual check: sign a displayed letter, try a different letter, hide your hands,
deny camera permission, switch tabs during capture, and retry. Verify that only
accepted matches update the island count and the camera stops when you leave.

## Project layout

- `SignSense/Main files/` — the active browser application. This is retained
  temporarily because Windows has it open; it is the only remaining legacy
  top-level application folder.
- `SignSense/Main files/dynamic_signs/` — add dynamic-sign reference MP4s
  here; see its README for the filename convention and recording guidance.
- `serve.py` — the local server. It discovers videos in `dynamic_signs/`.
- `archive/` — retained legacy files that are not loaded by the MVP.
