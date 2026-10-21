# Owner integration, 2026-10-21 (Tokyo)

## Exact baseline and integration map

Live owner PR15 was `d6fdefaa6884261d6288f3a72f95247268f74952`, not the older
ccda769/ba5cfa7 checkpoints in the supplied assessment. Local Git metadata was
at f0e4180 with extensive later files shown dirty/untracked. Before modifying
anything, tracked diff and untracked inventory were saved outside Git. EVERY
remote d6fdefa tracked blob was compared against actual working-file bytes:
**zero mismatches**. Only branch/index metadata were aligned to that already
present remote tree; no worktree reset, checkout, file replacement or deletion.

| PR | Live donor head | Owner relationship and action |
|---|---|---|
| 15 | d6fdefaa6884261d6288f3a72f95247268f74952 | Starting current owner; keep PR open against main. |
| 18 | bca22c5db9e54c69710d72b6b01714a2925c8f94 | Already an ancestor of d6fdefa. No duplicate integration or compatibility merge. Original PR/base unchanged. |
| 19 | 16a6e0be3bc09908e961d79d74901a7f5713823e | Isolated since ba5cfa7. Cherry-picked with attribution as e1b43b2; only overlap with subsequent Agent A paths was CI. No Waveyard/recovery code overwritten. |
| 20 | 04ea4bd62f8d261dfd2e26a65bf90bfe19ec6a6f | Isolated since ba5cfa7. Original d898fed/9e58434/04ea4bd individually cherry-picked as 50ad4ae/9fbe0f6/aaaa78b, preserving both locator-fix iterations. No overlap with PR19 product files. |

No donor branch was changed, no PR was automatically merged/closed/retargeted.
PR14 provisioning and PR16 memory experiment remain untouched. Agent B remains
feature owner; this is integration and regression work, not competing features.

## Waveyard is already implemented; prove instead of duplicate

On e1b43b2 (current owner + Arcade), locked dependencies and actual Chromium153,
PostgreSQL and native FFmpeg executed the complete authorised recording → FLAC
batch → verified ZIP → TrackPlayer → persisted/reopened session → Studio →
independently decoded WAV workflow: PASS. Original publisher asset SHA-256
`4b431d535d235bd81b62f816f08c3f1afb6679d2706d84b3b75903b7df909507`.
No inference/provider/subjective quality claim for this controlled journey.
Existing export notices are ALREADY automatically bundled: exact WAV/MIDI,
RIGHTS.txt and frozen-source manifest, with unknown rights honestly unknown.
Do not reimplement them. The provenance/publication/bundle/source-identity
integration subset passed **22 tests**, including actual standalone execution.

Prior exact d6fdefa trained four/six-stem + Gate D execution succeeded in hosted
run39463765306. This corrects the stale claim that no genuine inference evidence
exists; it does NOT certify any later combined revision. Final combined-head
checks are separate receipts, not inherited passes.

## Separate Arcade proof before Spaces

Exact e1b43b2: 28 focused game/attempt tests, production build, and two actual
Chromium/Next Arcade acceptance tests PASS. Includes isolation/denied navigation,
crashes/inertia, unforgeable transient runtime proof, bounded browser repair,
retained failed drafts, previous playable version/reopen and controlled fixture
mechanics. Scripted provider HTTP replies, NOT live-model creativity or arbitrary
prompt fidelity/fun. Standalone donor test counts are not combined-tree evidence.

## Combined recovery failure found and retained

After PR20 integration, existing mission-recovery + evidence tests gave
**10 pass / 1 fail**: large Unicode output preview not yet visible at assertion.
The unchanged failing case failed again in isolation. Diagnostic instrumentation
observed actual preview HTTP200 with all 270000 bytes and eventual DOM preview.
A diagnostic delay let the original integrity/restart/reuse checks pass, but
that diagnostic itself failed due to an unhandled response-body observer after
navigation; it is NOT a passing acceptance receipt.

Minimal test-boundary fix: install a preview response listener BEFORE clicking,
await the exact output/view response, assert HTTP200 and its complete original
bytes, then retain the original visibility/full text/download/restart/reuse
assertions. No sleeps, increased timeouts, skipped cases, changed product output
or relaxed existing integrity checks. Focused fixed case passes, including real
PostgreSQL restart, fresh Node retrieval and later command reuse of Unicode and
binary outputs. Raw failures and focused after-run are committed alongside this
file. Full combined recovery still needs execution on the final committed tree.

## Keep acceptance attached to the owner branch

Existing Arcade and Spaces dedicated workflows now also trigger on the fixed
owner branch, retaining their donor triggers and their original full-source /
actual-page checks. Explicit CI-only Arcade no-sandbox setting is also needed
by the Spaces combined source suite and generic durable-browser suite, which
now exercise the added publication gate. The production condition still also
requires CI=true; production OS sandbox policy is unchanged. No assertion or
workflow timeout was weakened and no new parallel validation pipeline added.

## Environment and evidence discipline

Initial npm ci failed when ONNX's optional installer contacted blocked NuGet;
raw install failure retained outside Git. Changed strategy: locked npm ci
--ignore-scripts, existing offline native-tool preparation, verified installed
CPU ONNX binding import, and unchanged nested worker locked install. No app
package/lockfile changes. Chromium153 test prerequisite came from pinned
@sparticuz/chromium153.0.0 via permitted npm, installed OUTSIDE the repository;
its shipped native NSS libraries are test-only LD_LIBRARY_PATH prerequisites.
Not an application dependency or Electron substitute. First package-entrypoint
attempt failed; direct ESM entrypoint extracted the actual Chromium executable.

Final combined full-source/build/browser/media/hosted outcomes must identify
their tested commit and source digest. Later receipts belong in the PR thread
and ignored `.data/` evidence rather than changing a frozen tested HEAD.
Counts overlap; never sum repeated suites into new capability claims.
Installed Electron/Windows, live-model creativity/autonomy and unprovided live
external-provider credentials remain separate gates. No owner return-to-Windows
requirement and no claims based merely on build/HTTP200/catalogue metadata.
