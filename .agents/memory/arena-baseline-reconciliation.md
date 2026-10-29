---
name: Arena baseline reconciliation
description: How to choose a code and product-spec baseline when Arena branches diverge.
---

When the user names a branch or asks to preserve earlier work, compare it with the checked-out branch and current project instructions/acceptance docs before editing. For major divergences, inventory local and remote refs, ancestry, branch-only commits and patch equivalence, then compare relevant behavior and test evidence against the current tree. Do not assume `main` is newest or that a branch's documentation is authoritative; apply the user's most recent direction first. When branches use different layouts, compare equivalent behavior and port targeted changes only. Patch equivalence is a lead, not proof that functionality or tests are preserved. Preserve branch tips and the worktree; do not merge, rebase, cherry-pick, or delete refs without explicit user authorization.

**Why:** Arena has divergent implementation branches with different project structures and product documents; choosing the wrong baseline or trusting commit similarity alone risks reviving stale requirements or missing real regressions.

**How to apply:** Check the worktree, refs, ancestry, relevant source, and acceptance tests at the start of substantive Arena work. Tell the user which baseline is in use when it differs from a branch they named, and preserve every inspected ref while comparing.
