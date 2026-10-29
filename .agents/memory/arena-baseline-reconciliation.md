---
name: Arena baseline reconciliation
description: How to choose a code and product-spec baseline when Arena branches diverge.
---

When the user names a branch or another body of work, compare it with the checked-out branch and current project instructions/acceptance docs before editing. Do not assume `main` is newest or that a branch's documentation is authoritative; apply the user's most recent direction first. When branches use different layouts, compare equivalent behavior and port targeted changes only. Avoid whole-branch merges without consent.

**Why:** Arena has divergent implementation branches with different project structures and product documents; silently choosing the wrong baseline risks reviving stale requirements or losing active work.

**How to apply:** Check the worktree, refs, ancestry, and relevant source/docs at the start of substantive Arena work. Tell the user which baseline is in use when it differs from a branch they named.
