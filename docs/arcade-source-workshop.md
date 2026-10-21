# First supported source/mod adapter

The Source workshop in `/arcade` acquires four real files from the official
`gabrielecirulli/2048` repository at
`478b6ec346e3787f589e4af751378d06ded4cbbc`, verified as MIT. Full license text,
source URLs, exact revision, hashes, source bodies, architecture notes, original
and modified manager hashes and a reviewable unified diff remain in the
downloadable JSON package and existing Artifact object/revision storage.

Supported modifications: **2–8 initial tiles**, replacing one exact constructor
anchor, and **guaranteed four-tile spawning**, replacing the actual
`addRandomTile` value rule (`Math.random() < 0.9 ? 2 : 4` → `4`). Both compose
without touching movement/merge/score logic. An upstream mismatch fails closed; it never adjusts the pin or guesses
at conflicts. `git apply --check`/replay and original/modded browser constructor
and restart counts are separate adapter acceptance checks. Acquisition itself
reports runtime **not run**; a historical CI pass is not labelled a per-request
gameplay execution receipt.

## Saved rule and reopen checkpoint

Selecting guaranteed-four generates an **unsaved** version-2 package, not a
claimed delivery. Open its unverified preview to inspect/play. “Verify rule and
save immutable game” first reconstructs the package from all four exact pins
and the two explicitly supported parameters, rejecting altered patches, source,
license, identity and claimed hashes. Client runtime claims are ignored.

A fresh Chromium instance uses the existing opaque `allow-scripts` iframe and
CSP, a clean profile, no inherited secrets and no external requests. The
targeted verifier supplies controlled random draws .01 and .95, executes the
original and modified upstream manager, presses real arrow keys and observes
the board-value sum delta. Merges conserve sum, so this delta measures a newly
spawned value rather than a HUD label. Original draws produce two/four; the
new rule produces four for both. It also checks initial counts and restart.
Controlled RNG is verifier instrumentation, never embedded in saved source.
The existing 10-second verification budget is not increased.

Only a fresh successful server execution can save a verified game. Its full
package, per-output report and exact source/patch hashes use the existing
private immutable object and owner-scoped Artifact revision store. Each save
creates a new Artifact; no update/overwrite path exists here. The original
initial-count acquisition retains its source-only save compatibility and is
explicitly labelled **not browser verified** until verified. Version-1
initial-count packages can be validated and reopened without rewriting history.

“Saved source games” lists existing owned source-patch Artifacts through the
normal library API. Reopen reads the **selected immutable revision**, verifies
the object bytes and pinned package again, repeats browser verification and
opens a fresh sandbox. Missing/foreign revisions, corrupt bytes, unavailable
Chromium, unsupported packages and failed writes never replace a prior saved
revision or the last working preview. Failures stay on the page with a download
for inspection; these attempt diagnostics are not durable across reload.
The UI distinguishes generated/unsaved, saved source-only, saved+verified and
failed attempts. Human review is always separate.

Run `node --import ./scripts/register-src-loader.mjs --test
tests/acceptance/arcade-rule-reopen.test.mjs` **after `npm run build`**.
This uses owned PostgreSQL, actual Next UI and real storage. It replays the
unified diff, measures gameplay before saving and after application reload/
immutable reopen, compares downloaded bytes and hashes, and exercises real
storage publication failure and corrupt-object reopening. Evidence goes to
`.data/arcade-source/rule-reopen-receipt.json` plus package/screenshot/trace.

### Acceptance ledger

| Gate | Current disposition |
| --- | --- |
| Source implementation and focused patch tests | Local implementation; hosted exact-commit evidence pending |
| Actual original/modified gameplay, immutable save/reopen, failure preservation | OPEN pending exact candidate actual-page workflow |
| Arcade + Spaces full source and applicable general CI | OPEN pending fresh candidate workflows; old `04d50f0` is historical only |
| Human owner review | OPEN — selected rule clarity, visible gameplay difference, find/reopen usability, truthful verification labels |
| Overall checkpoint | OPEN until automated gates and separately recorded human review pass |

Final run IDs/counts/source digests are recorded on the draft task PR without
editing a revision under verification. No PR merge, branch retarget or owner
integration is authorized by this checkpoint. No general modding ecosystem,
live-model quality, catalogue publication, Electron/Windows or in-progress
board-state persistence claim is made.

The opaque in-page and downloadable offline previews run real upstream GameManager/Grid/Tile
through Arena's small canvas, keyboard and memory-storage presentation adapters.
It is not the official 2048 UI, does not preserve playing-state across reloads,
and is not automatically installed/published into the game catalogue. It retains
MIT notice. No arbitrary upstream URL, archive extraction, dependency install,
DRM, general reverse engineering or unrestricted host execution is provided.
The downloaded JSON package is data; the HTML preview executes only when the
user explicitly opens it. Arcade's acceptance uses the opaque sandbox and
denied network, not Node eval/vm.

Public acquisition uses the existing public-destination/redirect policy,
fixed URLs, no redirects, a 10-second request deadline, 64KiB/file bounds and
four SHA-256 pins. Local Mode blocks egress; Ephemeral Mode does not persist the
package. Failed persistence returns a download warning, not a saved result.

Run `node --import ./scripts/register-src-loader.mjs --test
tests/acceptance/arcade-source.test.mjs` with Chromium installed. This test
requires real public source availability and must fail honestly if unavailable.
