# SignSense deployment handoff

This document records the current SignSense deployment and the decisions made
while moving Letter Island recognition from a local-only prototype to a hosted
site. Read this before changing deployment, authentication, progress, or model
code.

## Live services

| Component | Current location | Purpose |
| --- | --- | --- |
| Frontend | `https://gdgsignsense.netlify.app` | Static SignSense website hosted by Netlify |
| Letter model API | `https://signsense-api-222535336822.australia-southeast1.run.app` | Python/TensorFlow/MediaPipe prediction API on Cloud Run |
| Firebase / Google Cloud project | `signsensegdg` (project number `222535336822`) | Firebase Auth, Firestore, Cloud Run billing/project ownership |
| Model source repository | `https://github.com/anjalika-r/Modeltraining.git` | Trained checkpoint, inference configuration, predictor scripts, MediaPipe landmarker |

The frontend's API base is configured in:

```text
SignSense/Main files/api-config.js
```

It currently points to the Cloud Run URL above. Do not reset it to an empty
string for the hosted site: an empty API base makes the frontend request
`/api/letters` from Netlify, which returns an HTML 404 page and produces the
browser error `Unexpected token '<'`.

## Architecture

```text
Browser at Netlify
  ├─ regular word exercises: browser JavaScript MediaPipe Holistic + DTW
  ├─ Letter Island: captures JPEG frames and calls Cloud Run
  └─ current login/progress: localStorage demo only (not yet Firebase)

Cloud Run: signsense-api
  ├─ api_server.py
  ├─ Python 3.13
  ├─ TensorFlow + Python MediaPipe + OpenCV
  └─ Modeltraining repository cloned into /opt/model during Docker build
```

There are two independent MediaPipe uses:

1. `SignSense/Main files/exercise.js` loads JavaScript MediaPipe Holistic from
   jsDelivr for normal word exercises. It runs in the browser. The UI text
   `DTW ready` confirms it is functioning.
2. Letter Island sends frames to Python. `api_server.py` imports the
   Modeltraining predictor; Python MediaPipe extracts landmarks before the
   TensorFlow model predicts a letter. This runs on Cloud Run, not Firebase.

Firebase itself does not run MediaPipe or TensorFlow. It is intended for user
identity and durable progress data.

## Model currently selected

The hosted API deliberately uses exactly this model:

```text
/opt/model/models/letters_three_signers/best_lstm_model.keras
/opt/model/models/letters_three_signers/inference_config.json
/opt/model/models/holistic_landmarker.task
```

Although the Modeltraining repository may contain other model directories,
they are not selected automatically. To switch models, change `api_server.py`
and verify that the selected model's classes, feature format, threshold, and
reference images are compatible before deploying again.

Cloud Build only receives model files that are committed to the public
Modeltraining repository. It cannot access local paths such as
`C:\ANU\SignSense\Model 1\Modeltraining`.

## Deployment implementation

### Netlify

`netlify.toml` sets the publish directory to:

```text
SignSense/Main files
```

Netlify is connected to the `anjalika-r/SignSenseGDG` fork's `main` branch.
Pushing to that branch should trigger a frontend deploy.

### Cloud Run

`Dockerfile` does the following:

1. Starts with `python:3.13-slim`.
2. Installs Git.
3. Clones `https://github.com/anjalika-r/Modeltraining.git` into `/opt/model`.
4. Installs `/opt/model/requirements.txt`.
5. Copies `api_server.py` and the Letter Island reference images.
6. Starts `api_server.py` on Cloud Run's `PORT` (normally `8080`).

The API allows browser origins listed in the Cloud Run environment variable:

```text
ALLOWED_ORIGINS=https://gdgsignsense.netlify.app
```

The deployed Cloud Run service uses:

```text
region: australia-southeast1
memory: 2Gi
CPU: 2
minimum instances: 0
maximum instances: 1
timeout: 120 seconds
```

Minimum instances must remain `0` for a low-traffic demo unless a faster first
prediction is worth the ongoing idle cost. The first real recognition request
can be slower because the instance may have to start and load TensorFlow.

## Commands used to deploy

Run these from Google Cloud Shell in a current clone of SignSenseGDG:

```bash
git pull origin main
gcloud config set project signsensegdg
gcloud run deploy signsense-api --source . --region australia-southeast1 --allow-unauthenticated --memory 2Gi --cpu 2 --timeout 120 --min-instances 0 --max-instances 1 --set-env-vars "ALLOWED_ORIGINS=https://gdgsignsense.netlify.app"
```

The first source deploy required this IAM grant because the new project uses
the Compute Engine default account as Cloud Build's build account:

```bash
gcloud projects add-iam-policy-binding signsensegdg \
  --member="serviceAccount:222535336822-compute@developer.gserviceaccount.com" \
  --role="roles/run.builder"
```

Do not grant broad `Editor` merely to fix build permissions.

## Completed deployment fixes

The following commits were pushed to `anjalika-r/SignSenseGDG` on `main`:

| Commit | Change |
| --- | --- |
| `2340deb` | Added Cloud Run API, Dockerfile, Netlify config, and configurable frontend API base |
| `5991d20` | Fixed Docker handling of `SignSense/Main files/letter_signs` path containing a space |
| `00f3186` | Connected the Netlify frontend to the live Cloud Run API URL |

The Cloud Run build initially failed because Docker parsed the source path with
a space incorrectly. The fix uses Docker's JSON-array `COPY` form.

The subsequent build installed TensorFlow 2.21.0, MediaPipe 0.10.33, OpenCV,
and the model dependencies successfully, then deployed revision
`signsense-api-00001-8h4`.

## Firebase status and remaining work

The Firebase project exists. Email/password Authentication and Firestore were
created in the Firebase console, and a web app named SignSense was registered.
Firebase Hosting was also linked accidentally but is unused; Netlify remains
the frontend host.

Firebase is **not integrated in the repository yet**. The current code still:

```text
stores demo user records (including passwords) in localStorage
stores progress in localStorage
uses sessionStorage for loggedInUser
```

Before treating the site as a real user product, replace that with:

1. Firebase JavaScript SDK (CDN/module approach is appropriate because this is
   a static HTML/JavaScript site, not an npm application).
2. Firebase Auth email/password methods for sign-up, sign-in, auth-state
   redirects, and sign-out.
3. Firestore documents scoped by Firebase UID for exercise and letter progress.
4. Firestore Security Rules allowing a signed-in user to access only their own
   `users/{uid}` data.
5. Cloud Run verification of Firebase ID tokens on letter-attempt requests.
6. Rate limiting and/or Firebase App Check before exposing the model broadly.

Never store user passwords in Firestore or localStorage. Do not commit a
service-account JSON file, private key, billing data, or other credentials.
Firebase web configuration is public client configuration, but it should be
restricted to the deployed Netlify domain in Firebase/Google Cloud settings.

## Local development

The original local model location is:

```text
C:\ANU\SignSense\Model 1\Modeltraining
```

The frontend repository is:

```text
C:\ANU\25TH  SEP SIGNSENSE MVP\SignSenseGDG
```

For local Letter Island recognition, set the model directory in the PowerShell
session and start the server. Use a Python environment that has the model
requirements installed (the original environment required Python 3.13):

```powershell
Set-Location 'C:\ANU\25TH  SEP SIGNSENSE MVP\SignSenseGDG'
$env:SIGNSENSE_MODEL_REPO = 'C:\ANU\SignSense\Model 1\Modeltraining'
$env:SIGNSENSE_PYTHON = 'C:\ANU\SignSense\Model 1\Modeltraining\.venv\Scripts\python.exe'
python start_letters.py
```

Open `http://localhost:8000`.

## Troubleshooting guide

| Symptom | Likely cause | First check |
| --- | --- | --- |
| `Unexpected token '<'` in Letter Island | Frontend is calling Netlify rather than Cloud Run | Check `api-config.js` is deployed with the Cloud Run URL and hard-refresh Netlify |
| `Origin is not allowed` | Netlify domain does not exactly match `ALLOWED_ORIGINS` | Update the Cloud Run environment variable and redeploy |
| First prediction is slow | Cold start / TensorFlow checkpoint loading | Retry after the initial request; leave minimum instances at 0 for low cost |
| Cloud Run source-build permission error | Default Compute service account lacks build role | Grant `roles/run.builder` to `222535336822-compute@developer.gserviceaccount.com` |
| Docker fails on `Main files` copy | A Docker path with a space is not JSON-escaped | Preserve the JSON-array COPY command in Dockerfile |
| Normal exercises show no `DTW ready` | Browser MediaPipe CDN/reference-video issue | Inspect browser console/network; this is separate from Cloud Run Letter Island |

## Cost and safety notes

Cloud Run, Cloud Build, and Artifact Registry require a linked billing account.
The project was deployed with `min-instances=0` and `max-instances=1` to limit
idle and parallel inference costs. Budgets should be configured in Google Cloud
Billing; alerts do not automatically stop spending.

The deployed API is currently public so the Netlify browser can reach it. CORS
limits browser origins but does not authenticate arbitrary direct HTTP callers.
Add Firebase token verification and rate limiting before relying on this beyond
a supervised/demo setting.
