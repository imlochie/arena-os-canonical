# Bounded source absorption — 2026-10-19

STEM.FM cancellation gate remains **CLOSED**. Imported technology must improve an existing native path, not substitute external applications or runtime declarations for execution.

## SoundCraft comparison and executed integration

Reviewed source: `storytold/soundcraft` **25d52c646aea780c8076ff966076f994ad256221**, MIT OR Apache-2.0, workspace Rust 1.90/edition2024. Review used actual source, not README capabilities. No Cargo dependency/DAW/plugin host installed. Pre-alpha scope is not production proof.

| Implementation inspected | Waveyard comparison | Decision |
|---|---|---|
| `crates/audio-io/src/lib.rs`, native WAV/AIFF and Symphonia decode; streaming FileEncoder | Waveyard already uses FFprobe/FFmpeg validation/conversion and private verified file delivery, including explicit browser-compatible derivatives | Retain existing engine. Importing this crate requires Rust/WASM packaging and new codec/parity validation; no demonstrated advantage over current native conversion. |
| `crates/mix/src/lib.rs`, block render, per-clip gain evaluation at 32-sample boundaries; `crates/dsp/src/{util,offline}.rs` | Canonical PCM render already sums overlaps before nonlinear effects, handles tails, shares preview/export DSP, and reuses one scratch bus. Existing `packages/dsp/src/fades.ts` was ALREADY adapted from SoundCraft; do not re-import it as new work | Retain mixer/DSP and sample-accurate fades. Smoothers and sparse block evaluation are candidates only after measured need; do not introduce approximation into verified export timing. |
| `crates/model/src/automation.rs::AutomationLane::value_at` sorted breakpoint partition; `set_point` sorted insertion | Actual gap: `evaluateAutomation` sorted twice and built linear segments for EACH sample, called twice per frame by `prepareArrangementPcm` | **Implemented** sorted-once compiled evaluator + binary lookup, retaining Waveyard boundary/duplicate/seek semantics. Shared worker types are canonical; Arena re-exports them instead of maintaining a second copy. No allocations/sorting per evaluated sample. |
| `crates/playback/src/{lib,record,devices}.rs`, CPAL/device recording and callback transport | Waveyard HTML media/Web Audio session clocks, immutable donor assets, canonical PCM Worker audition, master recording/export are essential existing paths | Retain native Arena workflow. Replacing transport with CPAL requires a deliberate desktop audio boundary and new platform/device acceptance; browser coverage is not equivalent to this. |
| `crates/engine/src/{edit,autosave,file_access}.rs`, command/document edits; `crates/automation/src/lib.rs` | Arena already has persistent remix versions, explicit session handoff, permission-checked routes, runtime tools and task/job records | No wholesale engine/MCP import. SoundCraft headless backend explicitly drops transport requests; a headless response is not audible playback acceptance. |

### Measured dense-automation improvement

Command, unchanged before/after:

`node --import ./scripts/register-src-loader.mjs scripts/benchmark-arrangement-automation.mjs`

Node-only controlled PCM: one stereo track, one second at44100Hz, two1024-point lanes. Three rounds each, full `prepareArrangementPcm` (not isolated lookup):

- Before:4777.547875,4679.327187,4786.473312ms; median **4777.547875ms**.
- After:29.972894,21.387360,30.242288ms; median **29.972894ms**, approximately159.4× on this specific workload.
- Identical raw Float32 output SHA-256: `5183fa2841894687679dda7c8a1041646041cc1818ab75fdafc6c928e1cdc4c7`.
- Permanent regression compares to the previous algorithm on unsorted/duplicate/boundary/seek/fallback cases, bounds lookup work, and compares actual dense-automation rendered PCM (≤1e-7 sample-error threshold).
- No browser/Electron, real-song, memory improvement, plugin-host or whole replacement performance claim. Earlier ~531MiB/no-memory-win evidence remains unchanged.

Adaptation notice: `docs/licenses/soundcraft-MIT.txt` and worker `packages/types/LICENSE-SoundCraft.txt`; website container and staged desktop server retain notices.

## Other supplied source, selectively inspected

- `storytold/craft-libs` **ae2f796b673f29cf3161f36eb6a8933f0a3fe028**: actual `atomic/src/lib.rs` stages beside destination, syncs file, renames, best-effort syncs directory; it explicitly does NOT sweep crash orphans. `settings/src/lib.rs` has TOML merge/backups/recovery and migrations. `docpath/src/lib.rs` distinguishes stored URLs/local paths and Windows ADS/drive edge cases. Arena already has private safeLocalPath, DB settings, atomic storage/publication and migrations; importing Rust/TOML libraries is not a defensible replacement for those boundaries. Resume metadata is now revision-bound and atomically published in existing seeder; process-death tests are not power-loss proof. `ai-core/src/lib.rs` explicitly describes an interim data model without I/O/async execution. No AI execution capability imported or claimed.
- `storytold/artcraft` **7a2935cf9e3922e90e4ed5f3556b1cb107013148**: bounded source-tree/API contract research only, not a full application audit. `artcraft-services` **e57ee3d63ac478a24149384bf1473ef97aa067f8**: inspected actual `JobStatus`/`JobStatusPlus` enums (attempt-failed vs terminal failure, user/system cancellation), compared with Arena existing durable claim/retry/cancel states. **Its LICENSE.md is restrictive WIP fair-source, not assumed MIT/open-source permission for commercial incorporation. No backend code imported.** Do not copy its MySQL/Redis/provider/service architecture to get a router. No new provider or hosted execution is claimed.
- `AKCodez/higgsfield-claude-skills` **f6698ab7a87223b67a76ce748ca1b936a8b5d399**: README recovery uses manually maintained `SESSION-RESUME.md`; reviewed actual batch/recovery instructions, not treated as executable recovery machinery.
- `AKCodez/seo-god` **fa7b2c9c2540d4510e9494e91f2d825086e60f8f**: actual `scripts/daily-run.ps1` writes a dated run marker and invokes external Claude/OpenSEO; MIT. Do not import those external-app assumptions into Waveyard. The source-test runner now retains dated structured phase/result receipts with source digests, raw TAP, explicit failure status and totals, and reruns rather than treating interrupted work as accepted. This is bounded engineering evidence/recovery discipline, NOT autonomous/self-improving-agent acceptance.

No new product dependencies, model registry, engine, library or queue. Only ephemeral pinned Chromium153 test tooling was restored outside the repository after cache inspection; no model host retried.


## 2026-10-20 — bounded public-audio contract and publisher-licensed media reuse

- Inspected `jjjake/internetarchive` at4bb79621813fc5aaff5ad6d154a340dfd157d980: [search.py](https://github.com/jjjake/internetarchive/blob/4bb79621813fc5aaff5ad6d154a340dfd157d980/internetarchive/search.py), [session.py](https://github.com/jjjake/internetarchive/blob/4bb79621813fc5aaff5ad6d154a340dfd157d980/internetarchive/session.py), [files.py](https://github.com/jjjake/internetarchive/blob/4bb79621813fc5aaff5ad6d154a340dfd157d980/internetarchive/files.py). Public search/metadata/file URL contracts only; no Python package, implementation or licence imported. `internetarchive/ia` was an incorrect exploratory repository name (404), not a provider outage. Correct project is the one above.
- Existing Waveyard owner guards, public DNS/redirect policy, native intake/private storage, listening library/player and optional preparation retained. Added bounded `archive-audio.ts` + discovery panel/routes, no provider abstraction registry or extra persistence. CC0/CC-BY item claims need owner review and server recheck; contradictory file grants, NC/ND/SA, private/restricted/invalid files cannot acquire. Stored provenance/credits remain reachable after library reopen. Current Archive legal/service/geographic terms not retrieved from restricted host; live music catalogue remains UNACCEPTED. No streaming service/TunePat/DRM/private API involved. Jamendo remains unintegrated, credentials and applicable track terms unresolved.
- [Deezer/Spleeter media grant](https://github.com/deezer/spleeter/blob/c8854001ac8acad34a9bc2bd15f28475541828b1/README.md#note) specifically identifies `audio_example.mp3` as *Slow Motion Dream*, Steven M Bryant©2011, featuring CSoul/Alex Beroza/Robert Siekawitch, CC BY3.0; original credit http://dig.ccmixter.org/files/stevieb357/34740 . Distinct from the software licence. Verified262867-byte Git blobcc91788843d20ae7af169d6e0f72c2c5658fdb39, SHA4b431d535d235bd81b62f816f08c3f1afb6679d2706d84b3b75903b7df909507; preserved grant/credits and actual MP3/export in ignored `.data/acceptance/authorized-music/spleeter-demo/`. Publisher declaration is recorded, not an independent authorship warranty. No music binary committed. Real source-only intake/session/PG restart/Studio/export executed; no learned separation or live Archive claim.
- Existing pinned MDX files/recipe/seeder unchanged in identity. Owner-file import is the same checksum/publisher, not a mirror/weights trust bypass; acquisition provenance records origin and unverified/owner-asserted permission. Model licence string remains verify-before-bundling, not silently upgraded to MIT based on upstream code. `kuielab/mdx-net` main README/MIT code inspected, training environment/leaderboard links only; no licensed exact weights acquired. Node ORT available is not file/architecture execution. No blocked weight host retried; no PR14 import/merge.
