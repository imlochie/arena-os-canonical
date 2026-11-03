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

## Evidence and remaining model acceptance

The automated tool/mission tests use explicitly scripted inference for wiring
only. They exercise unique source edits, failed static builds, exact-artifact
approval, denial, stale artifacts, cancellation, fallback rejection, source
redaction in a **real persisted database journal**, and refusal of autonomous
resume. They are not real-model generation evidence.

The Chromium browser journey in `scripts/arcade-development-journey.mjs` now
passes without an owner session or model. It uses an original authorized HTML
coin fixture and verifies real controls and durable browser records:

- The base collects two coins. A manually saved draft changes collection from
  one to five points, with a displayed comparison and exact source hashes.
- Static checks make zero network requests. Broken syntax fails both checking
  and install-review preparation.
- Discarded reviews do not resume on reopen; expired reviews refuse commitment.
  Installation requires a fresh review and an explicit commit.
- The independent-save profile starts at zero, adds five, retains progress on
  reload/reopen, and rolls back to one-point collection without rewinding its
  save. The base source and two-coin save remain unchanged.
- A stale second tab cannot overwrite the newer development checkpoint.
- Fault injection aborts the development-checkpoint transaction after the
  Workshop install has committed. The UI reports that partial success, leaves
  the old checkpoint intact, and permits recovery through an explicit Workshop
  launch. Reopening does not automatically resume, install, or launch.
- A locally entered owner gameplay report remains labelled owner-reported;
  it is separate from the fixture's independent browser assertions and is not
  real-model evidence.

Run `node scripts/arcade-development-journey.mjs` against the running preview
(or set `TEST_BASE_URL`). Its report and screenshots are generated under
`generated-artifacts/arcade-development-journey/`. Clock manipulation and
transaction-abort injection are test-only; production storage is not bypassed.
This is Chromium evidence, not Windows packaging, physical mobile-device, or
selected-model acceptance.

Installation and the development checkpoint are separate durable operations.
Checkpoint/evidence failure after installation must be reported as partial
success, not as “nothing installed”; recovery must not automatically reinstall.

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
