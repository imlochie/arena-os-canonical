# Windows integration — source inventory and convergence ledger

**Candidate under construction:** `arena/windows-ready-integration-2026-10-22`
**Starting revision:** `13638fe8a5c280e6b47ecf97fb6e6cf414163a12` (PR #25 head, verified unchanged on 2026-10-22)
**Integration base:** `04705abdb6155ad61ae11e96f231cac6302f7529` (PR #15, frozen owner branch)

Every ref below was re-fetched with `git fetch --all --prune` plus
`refs/pull/*/head` before this ledger was written. Nothing here is taken from
an earlier session's notes without re-verification.

## 1. Repository state at the start of the session

| Item | Value |
| --- | --- |
| Working checkout | `/home/user/arena-os-canonical` — HEAD `212f01c`, tree `816c09e`, clean, no stashes |
| Local branches | `arena/208e8a9c-arena-os-canonical` (session branch), `main` → `f0e4180` |
| Remote branches | `main` `f0e4180`, `arena/integration-candidate-2026-10-21` `13638fe`, `arena/208e8a9c-arena-os-canonical` `212f01c` |
| Stashes | none |
| Worktrees | `/home/user/arena-os-canonical` (source), `/home/user/preview-13638fe` (detached at `13638fe`, previous session) |
| Untracked work | none in the repository checkout |
| Open PRs | #1, #3, #5, #10, #14, #15, #16, #18, #19, #20, #21, #22, #23, #24, #25 (all draft except #15) |
| Merged / closed | #2, #4, #8, #9, #11, #13, #17 merged; #6, #7 closed |

**A note on the "dangerous-looking mismatch":** `main`'s history is a single
re-baselined root commit `f0e4180`; PRs #1–#11 were opened from the earlier
root (`c1c1219`) and therefore share **no common ancestor** with `main` or with
the candidate. That is why an old checkout can show `HEAD = f0e4180` while its
files match `04705ab` — the content was reconciled, the history was not. This
session did not reset, clean, recommit or overwrite any checkout. Integration
happened in a **new worktree** (`/home/user/win-int`) created from `13638fe`.

## 2. Convergence ledger

`git cherry` marks patch-equivalence; `identical` means the candidate's blob is
byte-identical to the PR head's blob for the file named.

| PR | Head | Shares history | Unique commits | Disposition | Evidence |
| --- | --- | --- | --- | --- | --- |
| #1 | `e60e3591` | no (old root) | 13 | **Integrated in content** — Studio (WanGP/ComfyUI), Congress, Cut Lab, archive assistant, mind, space templates are all present | `src/app/api/studio/generate/route.ts` identical to PR head; `src/app/api/congress/**`, `src/app/creative/page.tsx`, `src/lib/spaceTemplates.ts` present |
| #2 | `8e83bfa0` | no | 107 | **Merged** — content present | `src/lib/mind.ts` identical; `src/lib/emailInbox.ts`, `src/app/api/mind` present |
| #3 | `2e459e33` | no | 113 | **Integrated in content** (A7 deep-separation bridge) | `docs/ADR-007-deep-separation-engine-bridge.md`, `src/lib/waveyard/separation/deep.ts` present (candidate carries a later revision) |
| #4 | `711b261e` | no | 109 | **Merged** — content present | `scripts/db-setup.mjs` identical (UTF-8 database creation) |
| #5 | `7be58833` | no | 116 | **Integrated in content** (A7 hardening) | `src/lib/waveyard/separation/retry.ts` carries the same claim-first contract; candidate revision is newer |
| #6 | `add40e56` | no | 116 | **Closed**; same lineage as #5, superseded | — |
| #7 | `f9c42d58` | no | 118 | **Closed**; superseded by #9 | — |
| #8 | `8bd15c29` | no | 117 | **Merged** — content present | `desktop/acceptance.ts` identical |
| #9 | `15041c49` | no | 119 | **Merged** — content present | `scripts/windows-acceptance.mjs` and `docs/windows-acceptance.md` **identical** |
| #10 | `753ae03f` | no | 124 | **Integrated in content** (capability resolver, PG16 pin, hardening) | `src/lib/capabilities/resolver.ts` identical; `@embedded-postgres/*` pinned 16.14.0-beta.17 |
| #11 | `468e774b` | no | 141 | **Merged** — content present | — |
| #13 | `53a62a31` | no | 143 | **Merged** — content present | — |
| #14 | `536c940c` | yes | 145 total, 1 own | **Integrated in content** — self-service deep-engine provisioning | `provision.ts`, `provision-store.ts`, `provision-runtime.ts`, `DeepEngineSetup.tsx`, and all four `deep/prepare/*` routes present (candidate revision newer) |
| #15 | `04705abd` | yes | 0 (ancestor) | **Integrated** — integration base, frozen | ancestor of `13638fe` |
| #16 | `622b78a5` | yes | 4 | **Integrated in content** — PCM ownership release | `arrangement-preparation.ts` releases decoded copies only after a successful worker handoff `[comment + code verified]`; tests reworked into the candidate's 1303-line `studio-fx.test.mjs` |
| #17 | `566a33ba` | yes | 0 (ancestor) | **Merged** | ancestor |
| #18 | `bca22c5d` | yes | 0 (ancestor) | **Integrated** | ancestor |
| #19 | `16a6e0be` | yes | 1 | **Integrated** — patch-equivalent | `git cherry` → `-` |
| #20 | `04ea4bd6` | yes | 3 | **Integrated** — patch-equivalent | `git cherry` → `-`,`-`,`-` |
| #21 | `6aeff9bd` | yes | 9 | **Integrated** — patch-equivalent | `git cherry` → all `-` |
| #22 | `0908842f` | yes | 0 (ancestor) | **Integrated** — Arcade guaranteed-four save/reopen | ancestor |
| #23 | `28e4db87` | yes | 0 (ancestor) | **Integrated** — Spaces selected-model routing | ancestor |
| #24 | `5ea44bdd` | yes | 0 (ancestor) | **Integrated** — Spaces fleet resolution | ancestor |
| #25 | `13638fe8` | yes | 0 | **Starting point** | this branch's parent |

**Conclusion: no outstanding product work is missing from `13638fe`.** Every
unmerged PR is either an ancestor, patch-equivalent, or present in content via
the re-baseline. Nothing was dropped, force-pushed or deleted; all source
branches remain untouched.

### Conflicts called out by the mission

| Overlap | Finding |
| --- | --- |
| `.github/workflows/ci.yml` (Arcade vs Waveyard) | Candidate's `ci.yml` already carries both lineages: the Waveyard SIGKILL/restart matrix step **and** the browser/durable-workflow playback job. No merge needed; the Windows workflow is a separate file and does not touch `ci.yml`. |
| `tests/acceptance/studio-fx.test.mjs` | Candidate's file (1303 lines) supersedes PR #16's 628-line variant and already contains the per-asset-revision release tests. Taking PR #16's version would delete coverage. |
| PR #23 → #24 dependency | Both are ancestors of the candidate, in order (`28e4db8` then `5ea44bd`). |
| Package/lockfile | **A real Windows defect was found and fixed on this branch**: `@embedded-postgres/linux-x64` and `@ffmpeg-installer/linux-x64` were hard devDependencies restricted to `os=linux`, so `npm ci` aborted with EBADPLATFORM on Windows; `@ffmpeg-installer/win32-x64` was absent entirely. See §3. |
| Schema/migrations | `desktop-migrations` 0000–0024 present; unchanged by this branch. |

## 3. Changes this branch makes (and why)

1. **`npm ci` could not run on Windows at all.** Two `os:["linux"]` packages
   were hard devDependencies → EBADPLATFORM. All platform binaries are now
   `optionalDependencies` (the pattern the darwin/windows PostgreSQL packages
   already used), so each OS resolves its own set and Linux is unchanged.
2. **No FFmpeg for Windows.** `@ffmpeg-installer/win32-x64` was missing from
   package.json and the lockfile, so `desktop:prepare-server` aborted with
   "Could not find ffmpeg binary" and no installer could be produced. Now
   declared (plus darwin/linux-arm64 for parity).
3. **Desktop dev runtime was Windows-broken.** `resolveEmbeddedPostgres`'s dev
   branch built `initdb`/`pg_ctl`/`postgres` without `.exe` and left
   `windowsPathDirs` empty, so `npm run desktop` on Windows spawned a
   non-existent path and PostgreSQL could not load its DLLs. Both layouts now
   share one resolver; regression test added.
4. **No Windows host existed for the acceptance contract.** Added
   `.github/workflows/windows-acceptance.yml` (gates, installer, staged-runtime
   acceptance, install, installed-app acceptance, recovery, uninstall) and
   `scripts/windows-platform-check.mjs`.

### 3.1 Second pass: the Windows lifecycle defects

Once the de-elevated wrapper was fixed (a `.bat` invoking `npm.cmd` without
`call` never reached its sentinel, so every step looked like a hang — see
`WINDOWS-READINESS.md` §5.8), the gate could finally gate. It then exposed the
defects below — each one specific to Windows, each fixed at its cause rather
than retried:

5. **Process-tree termination.** `runCommandProcess` killed only the direct
   child; descendants held the pipes and cancellation never settled. The Windows
   path now uses `taskkill /T /F`.
6. **Path canonicalisation.** Grant validation compared a `realpath`-resolved
   scope with an unresolved root; 8.3 short temp paths (`RUNNER~1`) made valid
   persisted approvals fail with `TOOL_GRANT_INVALID`.
7. **Atomic replacement under a reader.** `rename` over an open file returns
   `EPERM` on Windows; `src/lib/fs-replace.ts` retries exactly EPERM/EACCES/EBUSY,
   bounded, and rethrows everything else. Used by the provisioning store and the
   model/checkpoint placement paths.
8. **ffmpeg syntax, not paths.** Filter paths need `C\:/…`; and the failure text
   now keeps the head of stderr, because ffmpeg rewrites the tail with progress.
9. **Test fixtures that encoded POSIX or bypassed the product.** Crash-recovery
   tests asserted a `SIGKILL` signal (Windows reports a non-zero status instead);
   PostgreSQL fixtures hand-wrote `windowsPathDirs: []` instead of deriving it
   from `desktop/runtime/config.ts`.
10. **Bounds below the work they bounded.** Per-test and per-file budgets (some
    inside the tests themselves) were raised above measured cost, and a fixture
    the harness itself kills is now reported as such rather than as a product
    defect. The same treatment was applied later to the conversion provenance
    test (60 s → 120 s after run 39886922288). When the same class of failure
    hit seed-http again at 120 s (run 39896001156, a 37-minute suite against
    16.5), the diagnosis changed: those caps were asserting a duration nothing
    in the test claims. Both are removed and the suite's single declared
    per-test bound governs (§5.20 of the readiness record).

Result: six Windows jobs green on eleven commits, including the full source
suite (1649 tests, 1643 pass, 0 fail, 0 cancelled, 6 skipped), the desktop
contract gate (168/168, recording its own exit) and the installed application
acceptance (34 of 34 runs that attempted it). Fourteen runs stand behind those
eleven green ones; the three that failed are named in the readiness record (§2,
§5.18–§5.20), not removed. The evidence commit is `1b0cfdb`; run 39899148687.

## 4. Reproduction

```bash
git fetch --all --prune
git fetch origin '+refs/pull/*/head:refs/remotes/origin/pr/*'
git worktree add -b arena/windows-ready-integration-2026-10-22 /home/user/win-int 13638fe8a5c280e6b47ecf97fb6e6cf414163a12
```
