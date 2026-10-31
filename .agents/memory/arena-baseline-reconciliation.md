---
name: Arena baseline reconciliation
description: How to choose a code and product-spec baseline when Arena branches diverge.
---

When the user names a branch or asks to preserve earlier work, compare it with the checked-out branch and current project instructions/acceptance docs before editing. For major divergences, inventory local and remote refs, ancestry, branch-only commits and patch equivalence, then compare relevant behavior and test evidence against the current tree. Do not assume `main` is newest or that a branch's documentation is authoritative; apply the user's most recent direction first. When branches use different layouts, compare equivalent behavior and port targeted changes only. Patch equivalence is a lead, not proof that functionality or tests are preserved. Preserve branch tips and the worktree; do not merge, rebase, cherry-pick, or delete refs without explicit user authorization.

**Why:** Arena has divergent implementation branches with different project structures and product documents; choosing the wrong baseline or trusting commit similarity alone risks reviving stale requirements or missing real regressions.

**How to apply:** Check the worktree, refs, ancestry, relevant source, and acceptance tests at the start of substantive Arena work. When the user asks for a branch audit, include every local and remote ref, not only the named branch, and distinguish patch-equivalent commits from unique work. Tell the user which baseline is in use when it differs from a branch they named, and preserve every inspected ref while comparing.

For branch archaeology, first reconstruct the intended user outcome from product documents, commit history, acceptance criteria, and actual workflows; then compare that outcome with what a user can complete in the current app. A route, component, or similar implementation is not proof that the old direction survived. Mark whether a goal is directly evidenced or only inferred, and do not revive a separate historical product automatically. One recovered 2026-10-11 investigation identifies a “Digital World Audit” as a historical user framing: read-only discovery across devices, files/data, authorized accounts, privacy, subscriptions, and creative infrastructure, followed by evidence-backed review rather than automatic action. Treat it as a candidate to reconcile with current priorities, not as confirmed current scope.

**Why:** The user says multi-branch work has been misdiagnosed and meaningful product direction may have been forgotten; they want proactive improvements grounded in the real intent, without regressing useful work.

**How to apply:** Keep a branch-to-outcome map for substantial audits. For each product direction, record the source, expected user result, present UI and service path, tested evidence, and the concrete remaining gap. Prefer a useful new UX idea only when it reduces a verified workflow gap and does not replace working historical functionality.

Waveyard has distinct music paths: Apple/iTunes XML or CSV snapshots back up catalogue metadata; Library audio backup archives exact original source files already stored in Waveyard; Toolbox converts user-supplied media. In the hosted preview, Toolbox files are processed by the hosted API, while the packaged desktop app is intended to use its local API. Neither path extracts protected Apple Music subscription audio. The old TunePat bridge only launches the owner's installed app and relies on manual output import.

**Why:** Treating a launcher, catalogue snapshot, or general file converter as an Apple Music stream converter would repeat the product's core failure mode: claiming a capability the user cannot actually use.

**How to apply:** When reviewing Apple Music backup, distinguish metadata export, exact-original backup, conversion of files the user supplies, and protected-stream acquisition. Do not claim that TunePat conversion or Windows-local processing works without an end-to-end test on that target.

The user does not want TunePat as a dependency or paid requirement when a legitimate built-in path is feasible. Current Waveyard converts an accessible local track into a verified copy stored as a normal library track; its audio-backup route selects source-backed tracks and emits exact audio plus a CSV manifest. A historical conversion branch adds dedicated batch archive/review conveniences; do not merge its different app architecture wholesale. Current tests do not prove the converted-track-to-ZIP path end to end.

**Why:** The user wants a usable Apple Music library backup without paying for TunePat, while expecting truthful capability rather than a launcher or promise.

**How to apply:** Prefer first-party metadata import/export, exact-file backup, and conversion of accessible local files. Treat historical branch behavior as a source of acceptance criteria, preserve the current app structure, and do not add TunePat dependency or DRM-bypass logic.

Treat branch-only capability notes as leads, not current-state facts. A feature may have been ported to main since the note was written, while related export or conversion flows remain branch-only. The current generic audio ZIP can accept source-backed converted tracks, but the dedicated converted-batch archive remains a separate convenience. The 2048 source patch is a specific example, not a general reverse-engineering capability.

**Why:** Branch audits showed that prior notes can become stale: current Waveyard has generic audio backup and conversion routes, but a converted track has not yet been proven through the full backup flow.

**How to apply:** Recheck the current server route, UI entry point, and end-to-end acceptance coverage before calling work lost or complete. Test conversion → library selection → ZIP audio and manifest before claiming this path is proven. Compare capability semantics, not only ancestry or filenames, and port targeted behavior rather than old framework scaffolding.

The historical `scripts/pg-backup.mjs` is not a safe drop-in for the current desktop layout: it copies `data/postgres`, while the current install stores its generated database password separately at `runtime/db-password.json`. It also treats an unreadable or missing postmaster PID as evidence that PostgreSQL is not running.

**Why:** Restoring that utility unchanged could produce a database copy the app cannot authenticate to, or copy a live cluster after an uncertain PID check.

**How to apply:** Before restoring this capability, preserve and verify the matching credential as part of a protected backup, fail closed when process state is uncertain, prevent the backup destination from being inside the source, and test a round trip against the current Windows data root.
