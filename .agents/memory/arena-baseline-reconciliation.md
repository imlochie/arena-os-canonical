---
name: Arena baseline reconciliation
description: How to choose a code and product-spec baseline when Arena branches diverge.
---

When the user names a branch or asks to preserve earlier work, compare it with the checked-out branch and current project instructions/acceptance docs before editing. For major divergences, inventory local and remote refs, ancestry, branch-only commits and patch equivalence, then compare relevant behavior and test evidence against the current tree. Do not assume `main` is newest or that a branch's documentation is authoritative; apply the user's most recent direction first. When branches use different layouts, compare equivalent behavior and port targeted changes only. Patch equivalence is a lead, not proof that functionality or tests are preserved. Preserve branch tips and the worktree; do not merge, rebase, cherry-pick, or delete refs without explicit user authorization.

**Why:** Arena has divergent implementation branches with different project structures and product documents; choosing the wrong baseline or trusting commit similarity alone risks reviving stale requirements or missing real regressions.

**How to apply:** Check the worktree, refs, ancestry, relevant source, and acceptance tests at the start of substantive Arena work. When the user asks for a branch audit, include every local and remote ref, not only the named branch, and distinguish patch-equivalent commits from unique work. Tell the user which baseline is in use when it differs from a branch they named, and preserve every inspected ref while comparing.

Historical Waveyard conversion work must be described precisely: the TunePat integration only launches the owner's installed app and expects manual output import; a separate local-file conversion/archive workflow handles files the owner already has. Neither extracts protected Apple Music audio. Current library snapshots back up catalog metadata, not the audio files.

**Why:** Treating a launcher or metadata snapshot as an Apple Music converter would repeat the product's core failure mode: claiming a capability the user cannot actually use.

**How to apply:** When reviewing or proposing Apple Music backup, distinguish catalog/playlist snapshots from local audio conversion and from protected-stream acquisition. Do not claim TunePat conversion exists unless an end-to-end, authorized file workflow is implemented and tested.

The user does not want TunePat as a dependency or paid requirement when a legitimate built-in path is feasible. Keep metadata exports (Apple/iTunes XML, CSV, or JSON) distinct from an audio ZIP of exact unprotected originals already stored in Waveyard. Never treat a TunePat launcher or an XML file path as audio access, and do not claim protected Apple Music subscription streams can be converted.

**Why:** The user wants a usable Apple Music library backup without paying for TunePat, while expecting truthful capability rather than a launcher or promise.

**How to apply:** Prefer first-party import/export for metadata and exact-file backup for locally accessible originals. Clearly label the boundary; do not add TunePat dependency or DRM-bypass logic.

Treat branch-only capability notes as leads, not current-state facts. A feature may have been ported to main since the note was written, while related export or conversion flows remain branch-only. The 2048 source patch is a specific example, not a general reverse-engineering capability.

**Why:** Branch audits showed that prior notes can become stale: some historical Arcade validation and audio-backup work now exists in main, while the broader local-conversion archive flow is still absent.

**How to apply:** Recheck the current server route, UI entry point, and end-to-end acceptance coverage before calling work lost or complete. Compare capability semantics, not only ancestry or filenames, and port targeted behavior rather than old framework scaffolding.
