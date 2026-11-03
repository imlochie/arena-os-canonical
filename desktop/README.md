# Windows browser tasks

This is the native packaging path for the **current Vite frontend and Express
API**, not the retired Next.js standalone server. It is source code for a
Windows build, not a Windows-verified installer.

## Build on Windows x64

1. Install Node.js LTS (22+) if it is not already installed.
2. Open PowerShell in this project's folder.
3. Run `powershell -ExecutionPolicy Bypass -File desktop/Start-Windows.ps1`.
4. Run the installer created in `generated-artifacts/windows/`.

The Windows package compiles Waveyard's small native WASAPI host with the MSVC
C++ compiler. The local build script checks for `cl.exe` before installing or
downloading dependencies. If it is not installed, use the
`arenaforge-windows-x64` installer artifact from the Windows package workflow
instead of adding the Visual Studio C++ toolchain to a low-space laptop.

The `Windows x64 package` CI workflow builds and installs the current app tree
on a Windows x64 runner. Its isolated smoke check verifies that the installed
app starts, embedded PostgreSQL is ready, every packaged desktop migration has
run, and bundled FFmpeg and FFprobe execute from the installed
`resources\bin` directory. It also compiles and packages the native capture
host. Model-dependent work and real-audio processing are recorded as
`not_run`; this workflow does not claim those checks passed. It uploads the
installer and a `result.json` containing test statuses only; the report excludes
profile, library, and database contents.

The build downloads dependencies, Electron, Chromium, and embedded PostgreSQL.
No user credentials are required. A packaged app needs no system Node.js.
Before installing dependencies, the Windows script reports free space for the
workspace, temporary directory, installer output, FFmpeg cache, and user build
caches. It stops before installs or downloads if any checked location has less
than the required free-space threshold, or if a location cannot be checked. The
20 GiB default is an early-warning floor, not a measured minimum requirement;
it remains uncalibrated until real Windows runs have recorded the build phases.
Set `$env:ARENA_BUILD_MIN_FREE_GIB = '24'` in PowerShell before running the
script to raise the floor. During each build, free space is sampled every two
seconds and at dependency, Chromium, PostgreSQL, staging, unpacked-output,
installer, and interrupted-cleanup checkpoints. The local
`generated-artifacts/windows-build-space.json` report contains only generic
location labels and GiB measurements; it excludes filesystem paths and
inspection errors. It records the overall and per-location peaks. After a
failed package is cleaned and a later build runs, the report compares the
post-cleanup free space and peak usage with that retry. These figures show
observed changes, not proof that cleanup alone caused them. Later runs use 125%
of the measured peak, or the configured minimum if larger. Two-second sampling
can miss brief peaks. This report is local and ignored by version control. No
disk cleanup is performed automatically beyond generated build files after a
failed or successful package.

Linked build folders and dependency caches are resolved before checking space.
Both preflight and sampling query that same resolved directory, not its drive
letter, so junctions and mounted folders can use another volume. Missing output
folders use their nearest existing ancestor; a broken link or an inaccessible
target stops preflight rather than using the containing drive. If a checked
target becomes unavailable while sampling, the report records failed sample
counts and the script warns that measured peaks may be understated. Machine
paths and error details remain excluded from the saved report.
The portable checks include a native cross-volume link fixture when a second
writable volume is available. Windows junction and PowerShell execution remain
pending the final Windows acceptance pass; Linux results are not Windows proof.

Do not build from `.migration-backup`; the new path does not depend on it.
The build script installs only the desktop app, API, web app and their workspace
dependencies. This changes which packages are linked in `node_modules` for that
checkout; run `pnpm install --frozen-lockfile` to restore every workspace, or
pass `-FullWorkspace` when invoking the build script if you need them all now.
The Windows x64 package keeps only its matching ONNX Runtime binaries. A retry
clears the previous generated `desktop/stage` before compiling. After a
successful installer build, temporary `desktop/stage`, `desktop/dist`, and the
duplicate `generated-artifacts/windows/win-unpacked` app tree are removed; the
installer and reusable download caches remain. Failed builds retain their
current staging files for diagnosis. After stopping any build processes, remove
only generated staging from an interrupted build with
`node desktop/cleanup-build.mjs --failed-build`. This deletes `desktop/stage`,
`desktop/dist`, and `generated-artifacts/windows/win-unpacked`; it preserves the
installer, download caches, app data, and original media. If you need the
partial files for diagnosis, inspect or copy them before running cleanup.
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

## Arcade local-model prompt comparison

To compare a focused game prompt with a richer Pong prompt, close ArenaForge and
run this from PowerShell in the workspace. Build and install the current
checkout first with `desktop/Start-Windows.ps1` unless the executable already
contains this checkout:

```powershell
powershell -ExecutionPolicy Bypass -File desktop/Check-Arcade-Windows.ps1 `
  -Executable "C:\full\path\to\ArenaForge.exe" `
  -Model "qwen2.5-coder:1.5b"
```

The same run tests both prompts, in order:

1. A small canvas game with arrow-key movement, one collectible, and a score.
2. A single-screen Pong game with two paddles, separate W/S and arrow-key
   controls, a bouncing ball, a visible score, an immediate start, and an R-key
   restart that resets the score.

Run it again with `-Model "qwen2.5:3b"` to compare the larger documented Qwen
candidate. Each invocation uses only the named, already-installed model; model
results are not substituted or combined. The JSON records both prompt outcomes
even when one fails, and a run exits unsuccessfully unless both prompts pass.
The Pong case is opened in Arcade's normal isolated game preview and receives
both paddle controls. The runner samples the canvas to check each paddle's
movement, tracks the ball for movement and a direction reversal, waits for a
visible score change, then presses R and checks that the score returns to its
starting state. These are browser-observed gameplay checks, not source-code
heuristics. They are recorded under `flows.gameplayMechanics`, independently
from local-model routing, Arcade validation, and isolated startup. A Pong
generation/startup pass with failed mechanics is not an overall acceptance
pass. Each run updates `arcade-result.json` and also writes a
model-specific report (for example, `arcade-result-qwen2.5-coder_1.5b.json`) so
running the next model does not erase the previous model's results.

This requires Windows x64, Node.js 22+ and installed workspace dependencies for
the Playwright runner, plus Ollama running on `127.0.0.1:11434` with the named
model already installed. The app itself does not require system Node.js after
packaging. For a starting model, use Qwen 2.5 3B with at least 12 GB RAM, or
Qwen 2.5 Coder 1.5B with 8–11 GB RAM. These are total-system starting points,
not measured minimums, speed estimates, or quality guarantees. Model downloads
also need disk space (about 1 GB for 1.5B and 1.9 GB for Qwen 2.5 3B). No
provider credentials or WebGPU are used.

The generated reports record prompt generation, import and
gameplay-edit as separate flows. Only prompt generation runs in this check;
import and gameplay-edit are explicitly marked `not_run`, not inferred from
the generation result. Each prompt records whether the selected local model was
used, provider credentials were omitted, Arcade validation passed, the isolated
startup check passed, and a canvas loaded in the packaged app.

This Linux workspace has no Windows executable or Ollama service, so it cannot
produce a fresh real-model gameplay result. Run the PowerShell command above
once for every local model whose report you want to evaluate; each report is
model-specific and includes its own Pong mechanic results.

### Evidence status

The task's prior observation was that `qwen2.5-coder:1.5b` passed the focused
local-generation prompt but failed Arcade validation on a more demanding Pong
prompt. This is prior evidence, not a result reproduced on the current machine:
this Linux workspace has no Ollama service, and only a real Windows run counts.
The new comparison runner records fresh results per model and prompt so a
quality failure can be distinguished from model-routing or runtime failures.

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

### Arena backup and restore

Use the desktop app's **Data** menu to create or restore an Arena backup. The
backup always includes Arena's PostgreSQL records and matching database
credential. A passphrase (minimum 12 characters) encrypts all included files;
Arena does not save it.

During creation, opt in to any offered local folders: Waveyard storage and
capture recordings, downloaded models, and workspace files. Workspace-file
backup excludes browser profiles. Browser profiles are a separate, unchecked
choice because they may contain cookies, saved sessions, browsing history, and
logged-in accounts. Select them only if you accept that sensitive information
being included.

The backup stays in the destination folder you select; nothing is uploaded.
Creating a backup pauses Arena, confirms a clean PostgreSQL shutdown, and
verifies every included file. Unsupported entries such as symbolic links fail
closed. The current version encrypts file contents with AES-256-GCM and derives
the key from the passphrase with scrypt. Files are processed as streams, and an
encrypted index protects their original paths. The public manifest shows the
selected scope and opaque encrypted-file sizes and hashes, not included file
names or contents. Older version 1 backups encrypt only the matching database
credential; their database and optional local files remain readable.

Restore verifies the backup and protected credential, requires a new empty data
folder, and restores selected files only under that new Arena data root. The
files are decrypted into a temporary sibling folder, verified, and promoted
only after validation succeeds. The existing data folder is left in place. The
restore dialog shows the selected folders and flags the browser-profile privacy
implications.

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
