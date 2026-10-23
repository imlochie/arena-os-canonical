# Native separation: stopping, publication and runtime truth

2026-10-20. This is an implemented lifecycle repair, **not learned-inference
acceptance**. It reuses processing_jobs, existing source/stem objects, the local
broker, immutable banks and ProjectWorkspace. No new library, queue or project
format was introduced. Independent provisioning PR14 remains unmerged.

## User behaviour

- ProjectWorkspace exposes **Cancel separation** only when processing status
  reports a registered native separation executor. Editors/owners can request
  cancellation; project authorization is checked before changing the job.
- Queued jobs become cancelled without inference. Running jobs become
  `cancelling`, retain their active-target uniqueness claim, and stay visibly
  stopping across reloads. They become cancelled after the executor exits and
  attempts partial-output cleanup. They are not advertised as already stopped
  when the HTTP request returns 202.
- Demucs and compressed-source decoder children receive TERM, then KILL after
  one second if needed. Their promises settle after close, before input removal.
  CUDA-device probing accepts the same abort signal. Native ONNX calls cannot
  be preempted through this runtime: cancellation is checked before and after
  each inference chunk, then releases the session and discards the result.
- **Restart separation** creates a fresh attempt with the original target,
  source, device and parent-stem identity. The cancelled row and errors remain
  history; a newer active attempt still refuses the restart. This avoids racing
  the old broker task's final cleanup or reusing its queue identity.
- Remote workers deliberately return unsupported, rather than pretending that
  changing the database stopped a remote Python process.

## Publication and correctness

Inputs must match their persisted SHA-256 before a model is opened (including
recursive parent-stem inputs). Deep WAV outputs must also match the exact
nonempty source frame count, not merely decode successfully. Queued → preparing is an atomic executor claim.
Progress and failure updates cannot rewrite cancelled, cancelling or completed
rows. Completion locks the job row inside the **existing** stem-publication
transaction. Cancellation before that lock prevents all stem rows; cancellation
behind a successful commit observes complete. Uploaded, unpublished objects are
cleaned on cancellation/failure. If deletion fails, the stopped attempt retains
`cleanupFailedKeys` and an explicit warning; cancellation is not a cleanup claim.

The committed bank is now marked owned immediately after the transaction, before
derived-waveform enqueue/reporting. A later derived-job reporting outage must
never delete the already-published audio or downgrade its completed job.

## Readiness and dependency provenance

`/api/waveyard/separation/models` no longer calls a nonempty checkpoint plus
installed package metadata “prepared.” It asynchronously imports the selected
Demucs CLI and its native dependencies, hashes the checkpoint, and compares the
upstream eight-hex SHA-256 prefix. It returns the full computed digest and
`inferenceVerified: false`. Import success/checksums are explicitly **not** an
inference result or quality benchmark. The prefix is an upstream integrity
convention, not a cryptographic signature or independent rights warranty.
No pickle is deserialized during readiness. Diagnostics are bounded and cached
for 20 seconds by interpreter/environment and checkpoint stat; metadata probes
expire after 10 seconds so installation is not hidden until process restart.

Research rechecked directly against PyPI JSON and GitHub source on this date:

- PyPI now publishes **Demucs 4.1.0**, uploaded 2026-07-11, Python >=3.10, MIT
  package metadata, homepage `https://github.com/adefossez/demucs`. It is not
  accurate to call 4.0.1 the latest release. Current requirements differ from
  PR14's deliberately pinned 4.0.1 stack: current CLI uses sphn and torch >=2.1
  (platform-qualified requirements); torchaudio is no longer a universal runtime
  requirement. Readiness imports the CLI rather than hardcoding torchaudio.
- Current `demucs/pretrained.py` first tries Hugging Face for unqualified remote
  model names, while an explicit local `--repo` still selects LocalRepo and the
  legacy signature. This bridge retains that explicit local repository: no
  silent Hugging Face or remote checkpoint fallback.
- Facebook's original repo is archived. A nonarchived fork or a package version
  alone does not establish compatibility, weight permissions, or inference.
  Current upstream README declares MIT for Demucs; recording permissions remain
  separate. No package/checkpoint installer or untrusted mirror was introduced.

Sources: https://pypi.org/pypi/demucs/json ;
https://github.com/adefossez/demucs/blob/main/demucs/pretrained.py ;
https://github.com/adefossez/demucs/blob/main/README.md ;
https://github.com/facebookresearch/demucs ;
https://github.com/imlochie/arena-os-canonical/pull/14 .

## Evidence scope and remaining limits

Regressions execute real Python/decoder child lifecycles, real database/storage
handlers, actual ProjectWorkspace/browser requests, restart and waveform paths.
Controlled inference modules/WAV copies are labelled NOT LEARNED; none establishes
four/six-source inference, melody quality, commercial catalogue access, or full
real-recording → learned stems → project → export acceptance.

This environment has no installed torch/torchaudio/demucs and no located trained
checkpoint. The official legacy checkpoint and current Hugging Face hosts are
outside its outbound host allowlist; unchanged blocked downloads were not
repeated. Independent PR14's provisioning code was inspected and preserved,
not merged or replaced. Live Archive acceptance remains unproven. Electron doctor
still reports missing binary and display; native handler/browser checks are not
Electron or Windows acceptance. No return to Windows is required.

An application/process crash during `cancelling` is still an interrupted native
execution requiring recovery; there is no new cross-process lease or safe orphan
PID adoption here. Cleanup warnings retain failed object identities, not an
automatic deletion guarantee. These limitations keep the replacement gate CLOSED.
Final revision/check results are recorded in the ignored acceptance receipt and
PR15 follow-up; prior test totals are not reused as current acceptance.
