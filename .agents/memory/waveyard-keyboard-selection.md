---
name: Waveyard keyboard selection decisions
description: Why Studio separates clip focus from selection membership.
---

Keep keyboard focus independent of clip selection membership when extending Studio selection controls.

**Why:** Arbitrary nonadjacent selections need a way to reach an unselected clip without first discarding the existing group. Using Ctrl/Meta navigation for this would compete with browser and operating-system shortcuts, which the keyboard-selection requirements explicitly protect.

**How to apply:** Preserve composed groups while navigating or visiting clip handles and group-action buttons. Reserve explicit selection actions for membership changes, and check modified shortcuts on nested controls as well as clip bodies.
