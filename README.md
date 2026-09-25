# SignSense MVP

## Run the app

```powershell
py serve.py
```

Open `http://localhost:8000`, sign in or create a local demo account, then open
**Exercise 1: Dynamic Sign Practice**.

## Project layout

- `SignSense/Main files/` — the active browser application. This is retained
  temporarily because Windows has it open; it is the only remaining legacy
  top-level application folder.
- `SignSense/Main files/dynamic_signs/` — add dynamic-sign reference MP4s
  here; see its README for the filename convention and recording guidance.
- `serve.py` — the local server. It discovers videos in `dynamic_signs/`.
- `archive/` — retained legacy files that are not loaded by the MVP.
