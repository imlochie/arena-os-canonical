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

## Focused Arcade local-model check

To verify only Arcade prompt generation, without making success depend on a
separate browser-task capability, close ArenaForge and run this from PowerShell
in the workspace. Build and install the current checkout first with
`desktop/Start-Windows.ps1` unless the executable already contains this checkout:

```powershell
powershell -ExecutionPolicy Bypass -File desktop/Check-Arcade-Windows.ps1 `
  -Executable "C:\full\path\to\ArenaForge.exe" `
  -Model "qwen2.5:3b"
```

This requires Windows x64, Node.js 22+ and installed workspace dependencies for
the Playwright runner, plus Ollama running on `127.0.0.1:11434` with the named
model already installed. The app itself does not require system Node.js after
packaging. For a starting model, use Qwen 2.5 3B with at least 12 GB RAM, or
Qwen 2.5 1.5B with 8–11 GB RAM. These are hardware starting points, not speed
or quality guarantees. No provider credentials or WebGPU are used.

The generated `arcade-result.json` records prompt generation, import and
gameplay-edit as separate flows. Only prompt generation runs in this check;
import and gameplay-edit are explicitly marked `not_run`, not inferred from
the generation result.

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

The package includes ONNX Runtime's CPU engine and the Windows x64 DirectML
runtime dependencies (`DirectML.dll`, DXCompiler, and DXIL) for Waveyard's local
separator, plus a pinned Windows x64 LGPL shared FFmpeg/FFprobe build for
compressed audio, waveforms, and exports. The FFmpeg archive is SHA-256 verified, cached under
`generated-artifacts/windows-tool-cache`, and its license is included beside
the binaries in `resources/bin`. The shared libraries and tools add about
150 MiB installed. Automatic separation on Windows tries DirectML first and
falls back to CPU; each job records the provider it actually resolved.
Separation model weights remain a separate one-time download through Waveyard.
A build-time probe runs a real CPU ONNX session, but only a real Windows
measurement can establish whether DirectML is selected and how fast the
four-model separation runs on the target machine.

The FFmpeg package build downloads its pinned archive from GitHub during the
first Windows package build. If the upstream `latest` asset changes, the
checksum fails safely; update the pinned archive name and SHA-256 together
after reviewing the replacement release and its license.

## Measure Waveyard on Windows

After installing the rebuilt app, open Waveyard once and wait until it says
“Stem engine ready” (use “Prepare stems” if needed), then close ArenaForge.
Choose a real supported audio file under 15 minutes, such as the MP3 sample
provided for this project. The default measures a temporary 20-second excerpt
from the start. Pass `-StartSeconds 20` to sample later in the track, or
`-MaxSeconds 0` to measure the full remaining file; the original is unchanged.
With the workspace checkout
and its installed dependencies on the Windows machine, run:

```powershell
powershell -ExecutionPolicy Bypass -File .\desktop\Measure-Waveyard.ps1 `
  -Executable "C:\path\to\ArenaForge.exe" `
  -AudioPath "C:\path\to\song.mp3" `
  -MaxSeconds 20 `
  -StartSeconds 20
```

The test uses a temporary app-data directory and reads the existing model cache;
it does not modify the normal library or retain the audio. It measures import,
separation, first playable stem timing, resolved model/device, machine and file
metadata, process-tree memory, verifies distinct non-silent PCM in each output
stem, and checks that the four stems play while vocal isolation changes live
audio gains. The report includes `model.directMlSelected`; this records whether
the DML execution provider was selected, not per-operator GPU utilization.
It writes only that report to
`generated-artifacts/windows-waveyard/report-<timestamp>.json`. Share the
report, not the audio file, to finish the Windows measurement. The report
separates the source file's duration from the selected excerpt's offset and length.
