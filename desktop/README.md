# Windows browser tasks

This is the native packaging path for the **current Vite frontend and Express
API**, not the retired Next.js standalone server. It is source code for a
Windows build, not a Windows-verified installer.

## Build on Windows x64

1. Install Node.js LTS (22+) if it is not already installed.
2. Open PowerShell in this project's folder.
3. Run `powershell -ExecutionPolicy Bypass -File desktop/Start-Windows.ps1`.
4. Run the installer created in `generated-artifacts/windows/`.

The build downloads dependencies, Electron, Chromium, and embedded PostgreSQL.
No user credentials are required. A packaged app needs no system Node.js.
Do not build from `.migration-backup`; the new path does not depend on it.
The installer is currently unsigned; do not describe it as signed or production-verified.

## Free local model

Install and open Ollama. No cloud account or API key is used. Local models
have no provider usage quota or per-request fee; they still require RAM, disk
space and compute time. Performance and task quality must be measured on the
actual laptop. Small models are not guaranteed to follow every browser task.

In ArenaForge, open **Model Hub**, connect the detected Ollama runtime, download
or register an installed model, then select it in the workspace's **Task model**
control. Qwen 2.5 3B is a starting candidate for laptops with at least 12 GB RAM;
the check offers the smaller 1.5B model for 8–11 GB. Keep Ollama on loopback.
Local Mode permits this local inference but still blocks cloud AI requests.

## Actual Windows and live-model check

Close all Arena/ArenaForge windows. With the source dependencies installed, run:

```powershell
powershell -ExecutionPolicy Bypass -File desktop/Start-Windows.ps1 `
  -Action Check -Executable "C:\full\path\to\ArenaForge.exe"
```

The check:
- starts the packaged executable on actual Windows;
- connects a real installed Ollama model through Model Hub;
- creates a Pong game in Arcade with that real model, verifies the selected model and validation result, and boots the game in the isolated preview;
- submits a benign natural-language browser task in the Windows UI;
- verifies a click waits for approval, restarts, approves and resumes it;
- downloads the model's saved report through the UI;
- checks separate profiles and restart persistence using synthetic cookies;
- restarts and checks the mission, report, model registration and browser;
- saves `generated-artifacts/windows-check/result.json`.

The check uses a **new isolated data directory** and automatically approves
only its example.com/IANA information-link task. It does not approve real
workspace actions, use real accounts, or inject scripted model responses.
An error is recorded as a failure, not a simulated pass.

Send only `result.json` to the developer. The temporary check directory is
retained locally for diagnosis; do not upload its browser profiles or database.
Linux builds, fake-model tests, hosted previews and screenshots do not establish
that this check passed.

## Data and shutdown

Default state: `%LOCALAPPDATA%\Arena`, matching the original desktop convention.
An absolute `ARENA_DATA_DIR` overrides it. An `arena.portable` marker beside the
executable opts into `arena-data` beside the executable. Workspace files and
private Chromium profiles live under `data/space-workspaces/<id>/`.

The app keeps a stable API port so renderer selections survive restarts, uses a
loopback-only API, keeps Chromium outside `app.asar`, and shuts down browser
contexts via IPC before stopping PostgreSQL with `pg_ctl`. An occupied saved
port fails explicitly instead of silently changing the app's browser origin.
Existing databases are never deleted or reinitialised to fix startup errors.
The bundled PostgreSQL major remains 16 to match the retained desktop runtime.

The package includes the CPU ONNX Runtime needed by Waveyard's local separator.
Separation model weights are downloaded separately through Waveyard and are not
bundled. CUDA/GPU providers and FFmpeg are not bundled; use a PCM 44.1 kHz WAV
for a CPU separation check unless FFmpeg is installed separately. This package
still needs a real Windows Waveyard run before its speed or audio quality is
verified.

## Measure Waveyard on Windows

After installing the rebuilt app, open Waveyard once and wait until it says
“Stem engine ready” (use “Prepare stems” if needed), then close ArenaForge.
Choose a real stereo PCM 16-bit, 44.1 kHz WAV under 15 minutes. The default
measures the full file; for a faster first check, pass `-MaxSeconds 20` and
optionally `-StartSeconds 20` to sample a later section. With the workspace
checkout and its installed dependencies on the Windows machine, run:

```powershell
powershell -ExecutionPolicy Bypass -File .\desktop\Measure-Waveyard.ps1 `
  -Executable "C:\path\to\ArenaForge.exe" `
  -AudioPath "C:\path\to\song.wav" `
  -MaxSeconds 20 `
  -StartSeconds 20
```

The test uses a temporary app-data directory and reads the existing model cache;
it does not modify the normal library or retain the audio. It measures import,
separation, first playable stem timing, resolved model/device, machine and file
metadata, process-tree memory, and verifies that four actual stems play while
vocal isolation changes the live audio gains. It writes only that report to
`generated-artifacts/windows-waveyard/report-<timestamp>.json`. Share the
report, not the audio file, to finish the Windows measurement. The report
separates the source file's duration from the selected excerpt's offset and length.
