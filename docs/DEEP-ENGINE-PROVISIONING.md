# Deep-engine self-service provisioning (A7 follow-on)

Status: **implemented**. The deep (six-stem Demucs) engine is now
self-preparing, recoverable, verifiable and usable from inside
Arena — the owner no longer installs Demucs, configures Python
packages, locates checkpoint directories, edits environment
variables, or troubleshoots through a terminal.

This document records the authoritative upstream research behind
the implementation, the deliberate ADR-007 policy change, the
design, and the real-inference acceptance procedure that remains
an **owner-machine** step (and why it could not be executed in
the development sandbox).

---

## 1. Authoritative upstream facts (verified 2026-10)

Every claim below was read from the authoritative source, not
recalled. Where a fact could not be verified from an authoritative
source, it is marked as read-at-runtime rather than hardcoded.

### The engine

- **Demucs** — `facebookresearch/demucs` (the reference repo;
  the package is also maintained by its author at
  `adefossez/demucs`). License: **MIT** (code).
  Source: `github.com/facebookresearch/demucs`, `LICENSE`.
- **Latest stable release: 4.0.1** (PyPI, 7 Sep 2023). The
  `main` branch is `4.1.0a2` (pre-release); Arena pins the
  stable **4.0.1** so preparation is reproducible.
  Source: `pypi.org/pypi/demucs/json`.
- **Runtime dependencies** (`requirements_minimal.txt`, tag
  `v4.0.1`): `dora-search`, `einops`, `julius>=0.2.3`,
  `lameenc>=1.2`, `openunmix`, `pyyaml`, `torch>=1.8.1`,
  `torchaudio>=0.8`, `tqdm`.

### The Python compatibility trap (the decisive finding)

- Demucs' `setup.py` declares `python_requires >= 3.8`; its PyPI
  page says "at least Python 3.10".
- **The real constraint is `torchaudio`.** Demucs' own Windows
  guide (`docs/windows.md`) states torchaudio must be **no greater
  than 2.1** (2.2.0 is "sure unsupported"). The `main` branch's
  `requirements_minimal.txt` pins `torchaudio>=0.8,<2.1`.
- **`torchaudio` 2.0.x / 2.1.x publish Windows wheels only for
  CPython 3.8–3.11 — there is no CPython 3.12 wheel** (verified
  against the PyPI file listings for `torchaudio 2.0.1` and
  `torch 2.0.1`). Therefore **Python 3.12 cannot run a reliable
  Demucs 4.x stack on Windows**, even though the `setup.py` pin
  would technically allow a newer torchaudio.
- **Reliable baseline selected:** CPython **3.10 or 3.11** +
  **torch 2.0.1** + **torchaudio 2.0.1** (CPU). This is the
  newest torch/torchaudio pair that satisfies both the pin and
  the Windows ceiling, and it has CPython 3.11 wheels. GPU
  acceleration is an additional, separately-verifiable capability
  — CPU is the dependable default.

### The model checkpoint

- **Identity:** `htdemucs_6s`, the experimental six-source model
  (vocals, drums, bass, guitar, piano, other). Its bag file
  (`demucs/remote/htdemucs_6s.yaml`) is exactly
  `models: ['5c90dfd2']` — a one-model bag — so loading
  signature `5c90dfd2` IS loading `htdemucs_6s`.
- **Checkpoint file:** `5c90dfd2-34c22ccb.th`.
- **Authoritative source:** Demucs' own remote index
  (`demucs/remote/files.txt`, root `hybrid_transformer/`) resolves
  to `https://dl.fbaipublicfiles.com/demucs/hybrid_transformer/5c90dfd2-34c22ccb.th`
  — Meta's official Demucs model store. This is the same URL
  Demucs itself downloads from on first use. Observed size
  ≈ 52 MiB (a real download log shows `52.4M/52.4M`); the exact
  byte count is read from the HTTP response at download time,
  never hardcoded.
- **Integrity mechanism (the upstream contract):** Demucs verifies
  the checkpoint with `demucs/repo.py::check_checksum`, which
  computes `sha256(file)` and compares its **first 8 hex chars**
  to the `34c22ccb` encoded in the filename. The full SHA-256 is
  **not** published upstream; the 8-hex prefix IS the integrity
  contract. Arena verifies the **same** prefix after every
  download and every owner import — it never invents a digest.
  A file with the right name but wrong bytes is rejected, both by
  Arena's pre-placement check and by Demucs' own load-time check.

### Licensing and distribution (explicit, not assumed)

- **Code:** MIT (Meta Platforms). Free to use, modify, redistribute.
- **Weights:** **NOT MIT.** The pretrained checkpoints are
  distributed by Meta for **research / non-commercial use**; the
  weights license is ambiguous (the author has stated the models
  are research-oriented). Arena therefore:
  - **never bundles or redistributes** the weights (they are
    ~105 MB fp32 and not in this repository);
  - acquires them **only with the owner's explicit, informed
    consent**, from Meta's own authoritative store — functionally
    identical to the owner running `demucs` and letting it
    download — and verifies integrity before use;
  - **shows the owner the licensing condition** on the consent
    screen before any download;
  - never downloads on startup or silently.

### Network boundary of this development sandbox

The sandbox's outbound allowlist includes `pypi.org` and
`files.pythonhosted.org` but **not** `dl.fbaipublicfiles.com`
(the checkpoint store) or `download.pytorch.org` (the CPU torch
index). Consequences, stated honestly:

- The checkpoint and the CPU PyTorch wheels **cannot be
  downloaded here**, so **genuine inference was not executed in
  this environment** (see §5).
- The provisioning lifecycle is implemented and unit-tested with
  controlled doubles for the installer/download seams; the real
  end-to-end run is the owner-machine acceptance procedure.

---

## 2. The deliberate policy change (ADR-007)

ADR-007 D1a said: *"the model weights are a LOCAL checkpoint,
never a download — the app NEVER downloads it."* That decision
was made when the only path was the owner assembling the engine
by hand. This implementation **amends** that decision explicitly
(see the ADR-007 "Amendment — self-service acquisition" entry):

> With the owner's explicit, informed consent, Arena MAY acquire
> the pinned checkpoint from Demucs' own authoritative store
> (`dl.fbaipublicfiles.com`), verify it with Demucs' own
> checksum contract, and place it atomically into the app's
> models directory. Arena still never bundles or redistributes
> the weights, and never downloads without consent or on startup.

The change is reviewable here and in ADR-007; the implementation
does not quietly contradict the old decision.

---

## 3. Design (smallest durable change)

The existing deep bridge (`separation/deep.ts`) is reused intact
— same job pipeline, stem persistence, provenance, waveform
processing and UI. Provisioning wraps around it; it does not
fork it.

- **`provision.ts`** — pure planning, lifecycle states, consent
  and Python-fit evaluation. No I/O, so it is unit-testable and
  client-safe.
- **`provision-runtime.ts`** — the machine operations: environment
  discovery, managed-CPython acquisition, isolated venv creation,
  pinned dependency installation, trusted-source download with
  integrity verification, owner-checkpoint import, and the real
  inference smoke test. Argument-array spawning, timeouts,
  cancellation, trusted-host allowlist, atomic placement.
- **`provision-store.ts`** — the durable lifecycle manager: a
  status file and a single-flight lock with a heartbeat in the
  managed environment directory. Background execution, honest
  restart recovery, no Redis dependency.
- **`deep.ts`** — the managed interpreter becomes a first-class
  candidate (after the owner's explicit `WAVEYARD_DEEP_PYTHON`
  override), so **probe, run and diagnostics all resolve the SAME
  interpreter** — one path-resolution rule. A pointer file
  (`interpreter.json`) is published only after the inference probe
  passes, so readiness reflects reality and a removed interpreter
  or checkpoint is detected immediately.

**Lifecycle states:** `not_prepared → checking → awaiting_consent →
preparing_python → installing_dependencies → acquiring_model →
verifying_model → testing_engine → ready`, with `failed`,
`cancelled` and `recovering` for the honest failure paths.

**Isolation:** dependencies are installed into an application-
managed environment (`WAVEYARD_DEEP_ENV_DIR`, default
`.data/waveyard-deep-env` — git-ignored), never into global
Python. When no compatible system interpreter exists, Arena can
acquire the official CPython embeddable package into that same
directory — nothing is installed system-wide.

---

## 4. What the owner does now

1. In Arena, choose **Deep — 6 stems** as the separation target
   (or open the deep engine setup panel).
2. Arena reports the machine's real state: which interpreters it
   found, their versions, whether the checkpoint and FFmpeg are
   present — and exactly what is missing.
3. Arena shows the ordered plan and the consent screen: what will
   be installed or downloaded, why, its expected size, its
   verified source, where it will be stored, and its licensing
   condition.
4. The owner approves the material steps.
5. Arena prepares the isolated environment, installs the pinned
   engine, acquires and verifies the checkpoint, and runs a real
   inference smoke test — showing live progress, with cancel and
   retry.
6. Arena reports **Ready** only after the inference probe passes,
   with the verified Python, Demucs and PyTorch versions, the
   provenance string, and the checkpoint path.

The owner never opens a terminal, installs anything globally, or
edits an environment variable on the normal path.

---

## 5. Real-inference acceptance (owner machine) — OPEN

This is the defining acceptance and it must run on a machine that
can reach the checkpoint and PyTorch stores (this sandbox could
not). It is **executable as written**; every step is a real
operation, not a mock.

**Prerequisites:** none to install by hand — Arena prepares
everything. The procedure verifies Arena did it correctly.

1. In Arena, open the deep engine setup and choose **Inspect &
   prepare**. Confirm Arena reports the machine accurately
   (interpreter versions, missing checkpoint/dependencies).
2. Approve the consent screen. Watch the preparation progress to
   **Ready**.
3. In the setup panel, confirm the **verified facts**: the actual
   prepared Python executable path, the installed **Demucs**
   version (expected `4.0.1`) and **PyTorch** version
   (expected `2.0.1`), and the managed-environment location.
4. Confirm the exact checkpoint path
   (`<WAVEYARD_MODELS_DIR>/5c90dfd2-34c22ccb.th`) exists.
5. Verify the checkpoint with Demucs' own mechanism: its sha256
   must begin with `34c22ccb` (Arena already did this; re-check
   with `sha256sum <path>` — first 8 hex chars).
6. Run a real separation through Arena's UI (upload an actual
   song, choose **Deep — 6 stems**). This goes through Arena's
   actual deep-separation job pipeline (`deep-stems` route →
   durable `processing_jobs` row → local worker → `runDeepSeparation`).
7. Confirm the job completes and produces **all six** stems:
   vocals, drums, bass, guitar, piano, other.
8. Confirm each stem file exists and contains valid, non-empty
   audio (the pipeline already refuses empty/invalid WAVs).
9. Confirm the output audio properties the pipeline requires:
   44.1 kHz, stereo, 16-bit PCM (the handler decodes and
   validates each stem before persisting).
10. Confirm the provenance recorded on the stem rows is exactly
    `htdemucs_6s@5c90dfd2-34c22ccb/demucs-4.0.1`.
11. Confirm the durable job row reached `complete` and the six
    stem assets are correctly attributed to the source and
    separation job (parent-stem relationships intact for layers).
12. Confirm the six lanes surface in the Waveyard stem deck and
    are playable (the deck renders and plays the stored assets).
13. **Failure honesty:** remove or corrupt the checkpoint and
    confirm Arena reports not-prepared with the exact path and a
    recovery path — never a fake stem. Interrupt preparation
    (restart Arena mid-run) and confirm it reports `recovering`,
    not `ready`.

**Genuine inference was NOT executed in this development
environment.** The checkpoint host and the CPU PyTorch index are
outside the sandbox's network allowlist, and installing the
~1 GB torch/demucs stack here was neither authorized nor useful
as evidence. The real-runtime acceptance above must be run on an
owner machine (or an environment with outbound access to
`dl.fbaipublicfiles.com` and `download.pytorch.org`) to close
this item. The automated suite proves the lifecycle, contract and
failure handling with controlled doubles — it does not pretend to
prove inference.

---

## 6. Evidence classification

- **Implemented:** the full provisioning lifecycle, isolation,
  checkpoint acquisition + integrity, import path, durable
  background status with restart recovery, cancellation, the
  managed-interpreter resolution in the real bridge, the API
  surface, and the UI flow.
- **Automatically tested:** planning, state machine, Python-fit
  evaluation, consent validation, URL trust policy, checksum
  verification, interrupted/failed downloads, corrupted checkpoints,
  concurrent/cancelled setup, executor failures, persistence,
  single-flight locking, restart recovery, route integration, and
  the existing deep-bridge behaviour (regression).
- **Tested against real services:** not in this sandbox (network
  boundary) — the A7 queue acceptance suite is separate and
  passing (PR #13).
- **Tested through genuine inference:** **not yet** — blocked by
  the sandbox network boundary; the owner-machine procedure in §5
  is the acceptance path.
- **Not verified here:** the managed-CPython acquisition and the
  pinned pip install against the real indexes (their logic is
  implemented and unit-tested with doubles; the real download is
  exercised in §5).
