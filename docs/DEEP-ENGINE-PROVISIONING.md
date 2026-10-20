# Managed native Demucs preparation — A8 implementation

## Scope and provenance

The existing PR14 preparation planner/runtime/manager/UI has been selectively
reconciled on the PR15 owner branch, without merging or modifying PR14. Owner
cancellation, immutable bank publication and source-validation protections remain.
The single managed installer can prepare two explicitly different native targets:

| Product id | Actual trained model | Official checkpoint | Independent outputs |
|---|---|---|---|
| `deep_4s` | `htdemucs` | `955717e8-8726e21a.th` | vocals, drums, bass, other |
| `deep_6s` | `htdemucs_6s` | `5c90dfd2-34c22ccb.th` | vocals, drums, bass, guitar, piano, other |

The four-source target is an additional, visibly labelled **Demucs** choice. It
is not the MDX `stems_4` recipe and is not made by grouping six-source outputs.
MDX four-source trained inference remains a separate acceptance requirement.
Authoritative legacy identities: `facebookresearch/demucs`'s
`demucs/remote/htdemucs.yaml`, `htdemucs_6s.yaml`, and `remote/files.txt`.
Only the local repository/signature is passed to Demucs; no automatic remote
model-name fallback. Downloads use the publisher's
`https://dl.fbaipublicfiles.com/demucs/hybrid_transformer/` store, HTTPS,
manual redirects with a closed hostname allowlist, a 200 MB limit, bounded
streaming, and upstream's eight-hex SHA-256 filename check before atomic placement.
This prefix is **not** a publisher-signed full SHA-256. The full locally computed
hash is retained in preparation and successful music-job receipts. Size shown
before acquisition is an estimate, not an invented authoritative byte count.

## Deliberate legacy compatibility baseline

`demucs==4.0.1`, `torch==2.0.1`, **`torchaudio==2.0.2`**, `numpy==1.26.4`,
`pip==25.0.1`; compatible base Python 3.10/3.11, isolated app-managed venv.
The corrected torchaudio version corresponds to torch 2.0.1; PR14's 2.0.1
pairing was not correct. CPU torch wheels use the explicit official PyTorch
CPU index; Demucs/numpy/pip use explicit PyPI, with inherited pip index
configuration isolated. Resolved `pip freeze --all` is mandatory before ready
and is saved as `dependencies.lock.txt`. This is a resolved execution record,
**not** a pre-resolved hash-locked transitive dependency graph.

4.0.1 is not described as latest. Author-maintained `adefossez/demucs` 4.1.0
uses torch >=2.1, safetensors, sphn and additional modern dependencies. Switching
to that distribution silently would not establish compatibility with this
legacy bridge, Python range and `.th` checkpoints. Its real execution remains
a separate comparison, not a claim made from PyPI metadata.

## Permissions

Upstream repositories declare Demucs MIT. The prior PR14 prose categorically
calling the weights research/non-commercial and non-MIT was not supported by
the inspected upstream evidence and is not repeated as fact. A separate
checkpoint-use grant has not been independently established. The owner sees
the source, estimated resources, license declaration and this uncertainty before
approving acquisition. Code, checkpoint, and recording permissions are separate;
installation is no commercial clearance warranty. No weights are committed or
uploaded as CI artifacts. Owner imports must match the selected checkpoint's
actual content identity, not merely its filename.

## Product path and honest readiness

The preparation UI is mounted in upload/project and owned-library-player paths.
The existing prepare endpoints accept the selected Demucs `model`; both share
one interpreter and exclusive preparation lock, with separate per-model status
records. Consent precedes material operations. Progress/log survives navigation;
cancel/retry/recovery invoke backend actions. A re-test starts the real CLI
smoke, not merely another metadata fetch. Readiness is published only after all
selected stems decode as 44.1 kHz stereo at the synthetic smoke's frame length,
and are not all byte-identical. A smoke receipt distinguishes this synthetic
signal from legitimate-music/quality acceptance. Removing/changing a recorded
checkpoint or dependency record invalidates remembered ready state.

`POST /api/library/tracks/:id/separation` uses owned source assets, existing
claims/jobs and native worker. Playback remains unchanged until the user
explicitly loads a completed bank. The player shows durable job history/errors
and links to existing processing recovery. Stem model ids/versions distinguish
four/six/MDX; six-source residual `other` remains Other, not a promise of Melody.

## Execution evidence and remaining boundaries

The opt-in `A8 genuine native inference` workflow runs only commits marked
`[a8-inference]` on the owner branch. It invokes the actual managed preparation,
real publisher CC-BY recording upload, native player separation action, existing
worker, independently decoded stems, persistent bank/session, Studio handoff,
immutable arrangement version and full FFmpeg-decoded export. It retains an
always-written gate receipt, attribution, audio, screenshot and browser trace;
it never substitutes a mock download/process/inference seam. A runner failure
is failure, not a passed gate. See Actions and the appended continuation entry
for actual outcomes; the existence of this workflow is **not execution proof**.

Open boundaries: desktop/Electron and Windows acceptance; genuine MDX ONNX
four-source execution; durable separation crash lease/child guardian and full
crash-window matrix; complete hash-pinned dependency graph; independent semantic
stem quality assessment; Windows embedded Python publisher digest verification;
preparation lock recovery/write ordering under adversarial process crashes.
These remain open even if Demucs music execution passes. Do not average A–F or
call the STEM.FM replacement gate complete.
