---
name: Arena baseline reconciliation
description: How to choose a code and product-spec baseline when Arena branches diverge.
---

When the user names a branch or asks to preserve earlier work, compare it with the checked-out branch and current project instructions/acceptance docs before editing. For major divergences, inventory local and remote refs, ancestry, branch-only commits and patch equivalence, then compare relevant behavior and test evidence against the current tree. Do not assume `main` is newest or that a branch's documentation is authoritative; apply the user's most recent direction first. When branches use different layouts, compare equivalent behavior and port targeted changes only. Patch equivalence is a lead, not proof that functionality or tests are preserved. Preserve branch tips and the worktree; do not merge, rebase, cherry-pick, or delete refs without explicit user authorization.

**Why:** Arena has divergent implementation branches with different project structures and product documents; choosing the wrong baseline or trusting commit similarity alone risks reviving stale requirements or missing real regressions.

**How to apply:** Check the worktree, refs, ancestry, relevant source, and acceptance tests at the start of substantive Arena work. When the user asks for a branch audit, include every local and remote ref, not only the named branch, and distinguish patch-equivalent commits from unique work. Tell the user which baseline is in use when it differs from a branch they named, and preserve every inspected ref while comparing.

Waveyard has distinct music paths: Apple/iTunes XML or CSV snapshots back up catalogue metadata; Library audio backup archives exact original source files already stored in Waveyard; Toolbox converts user-supplied media. In the hosted preview, Toolbox files are processed by the hosted API, while the packaged desktop app is intended to use its local API. Neither path extracts protected Apple Music subscription audio. The old TunePat bridge only launches the owner's installed app and relies on manual output import.

**Why:** Treating a launcher, catalogue snapshot, or general file converter as an Apple Music stream converter would repeat the product's core failure mode: claiming a capability the user cannot actually use.

**How to apply:** When reviewing Apple Music backup, distinguish metadata export, exact-original backup, conversion of files the user supplies, and protected-stream acquisition. Do not claim that TunePat conversion or Windows-local processing works without an end-to-end test on that target.

The user does not want TunePat as a dependency or paid requirement when a legitimate built-in path is feasible. Current main has general per-file/batch Toolbox conversion and an audio ZIP of exact originals stored in Waveyard. A historical conversion branch has a dedicated durable music workbench with metadata review and verified converted-batch archives; that behavior is not equivalent to the current Toolbox and should be ported selectively, not restored by merging its different app architecture wholesale.

**Why:** The user wants a usable Apple Music library backup without paying for TunePat, while expecting truthful capability rather than a launcher or promise.

**How to apply:** Prefer first-party metadata import/export, exact-file backup, and conversion of accessible local files. Treat historical branch behavior as a source of acceptance criteria, preserve the current app structure, and do not add TunePat dependency or DRM-bypass logic.

Treat branch-only capability notes as leads, not current-state facts. A feature may have been ported to main since the note was written, while related export or conversion flows remain branch-only. The 2048 source patch is a specific example, not a general reverse-engineering capability.

**Why:** Branch audits showed that prior notes can become stale: some historical Arcade validation and audio-backup work now exists in main, while the broader local-conversion archive flow is still absent.

**How to apply:** Recheck the current server route, UI entry point, and end-to-end acceptance coverage before calling work lost or complete. Compare capability semantics, not only ancestry or filenames, and port targeted behavior rather than old framework scaffolding.
