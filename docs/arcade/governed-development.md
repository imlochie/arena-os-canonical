# Governed Arcade development

## Supported workflow

Arcade → **Develop mods** currently supports an owner-authorized offline HTML
import up to 50 KB. Native engine editors, ROM disassembly, arbitrary build
commands and external assets are not supported by this adapter.

1. Select an imported game and confirm authorization.
2. Open its browser-local development copy. Compare or manually edit the
   actual source; save explicit checkpoints.
3. Optionally select a running local code model registered in Model Hub and
   request a gameplay change. This uses the existing Spaces mission runner,
   generation routing, governance ledger and single-claim approvals.
4. Review the modified source and exact artifact hash. Static checks compile
   inline scripts without executing them. A completed build is not gameplay
   verification. A valid proposal is handed to an exact-artifact human review,
   even if the model forgot to request installation.
5. Approve the proposal, review the Workshop manifest, then explicitly commit.
   The immutable imported record and its original save identity are untouched.
   The development profile uses independent saves.
6. Play the installed profile, record owner observations, and keep or roll back.
   Rollback changes installed content, not the profile's progress.

## Privacy and authority

- Original/draft source is stored only in a separate browser-local IndexedDB.
  There are eight bounded development copies. Each draft is limited to 50 KB.
- Manual static checks parse scripts inside the browser without executing them,
  login, or network access. Explicit model-run requests transmit source to Arena's authenticated API. Source is
  request-scoped there, never written to the public game catalog, a server
  filesystem workspace, mission journal, or approval payload.
- Cloud/provider cascades and the deterministic Local Engine are not accepted
  as code generation. This workflow currently accepts only local-server and
  TurboAgent routes with loopback destination enforcement.
- WebGPU is not involved. A CPU/GPU local server can supply inference.
- Every model tool call is limited to the explicit game/base-bound development
  context. There are no generic shell, network, arbitrary file or browser tools.
  Repository comments and game source cannot grant permissions.
- Missions store source provenance, model/backend/route identity, artifact
  hashes, static diagnostics and approval decisions. Source reads, replacement
  text and model free-text commentary are redacted before journal persistence.
- Install/launch approvals are signed for the exact development/base/output
  identity. Denied/claimed decisions are not replayed. Changed artifacts fail.
- The generic mission endpoint and daemon cannot resume Arcade work without an
  explicit owner request rehydrating its browser-local source. Reopening a copy
  does not resume, install or launch anything.
- AI-derived lineage survives subsequent manual edits. Locally built packages
  are visibly unverified derivatives, not upstream releases. Their replacement
  HTML is non-redistributable by default; Workshop portable exports retain
  their existing restricted-payload exclusions.
- Browser installation/launch/rollback and gameplay assessments are marked
  **owner-reported**, never presented as independent server gameplay evidence.

## Evidence and remaining blocker

The automated tool/mission tests use explicitly scripted inference for wiring
only. They exercise unique source edits, failed static builds, exact-artifact
approval, denial, stale artifacts, cancellation, fallback rejection, source
redaction in a **real persisted database journal**, and refusal of autonomous
resume. They are not real-model generation evidence.

The browser pass observed authorized import, real base progress, opening a
separate development copy and saving a manual checkpoint. It stopped when the
old API-backed static check required a hosted owner session. That dependency was
removed: manual checks now parse locally. Focused follow-up checks prove local
parsing and the actual generated-package → Workshop composition contract,
including restoring original content and retaining unverified AI lineage.
The remaining browser install/play/reopen/rollback journey has not been claimed
as passed. No second broad browser pass was run.

At implementation time the model registry had no registered local-server code
model. TurboAgent catalog entries alone are not proof of a configured server.
No real selected-model gameplay modification has been verified. This is an
explicit acceptance blocker, not a preset or mocked inference success.

## Real selected-model acceptance (deferred local-machine pass)

Use a small original authorized browser fixture: a Collect button adds one
coin and stores progress. First collect two coins in the original.

1. Register a running local code model in Model Hub. Record its actual model
   tag/version and local host. Do not infer readiness from a catalog entry.
2. Select that exact model in Develop mods and request: “Collecting a coin
   should add five points instead of one; preserve all other controls.”
3. Confirm a real model call, non-fallback backend and actual local host/model
   in the journal. Inspect a real source diff changing the mechanic.
4. Approve the output hash and explicitly install into an independent profile.
5. Launch: verify collecting adds five points, not merely a rendered canvas.
   The independent profile starts separately; the original still has two coins.
6. Reload/reopen and confirm both saves. Roll back: the profile retains its
   progress but collecting adds one again. The base source/progress is unchanged.
7. Reject a second proposal, cancel an in-flight request, break a script so the
   build fails, and alter a reviewed hash. None may install or damage the last
   playable profile. Reopening after interruption must not resume privilege.

Do not mark that real-model acceptance as passed until it has actually run.
