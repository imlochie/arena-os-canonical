---
name: Arcade runtime management boundaries
description: Why runtime metadata stays separate from private payloads and verification remains scoped to exact execution context.
---

Runtime management must not reimport existing games, regenerate identities, merge identical-source games or rewrite progress merely to add manifests.

**Why:** The user's earlier work and private saves must survive expanding Arcade beyond browser players; a cleaner launcher must not erase the original product.

**How to apply:** Keep metadata migration recoverable and separate from authoritative source/ROM/history/save stores. Retain save-slot aliases. Version-key metadata so an older open source version cannot replace another version's record.

Runtime registration and declared requirements are not installation, startup or gameplay proof.

**Why:** Arcade's broader native/emulator/mod targets otherwise become another collection of configured names rather than functioning capabilities.

**How to apply:** Bind a real launch driver and resource owner before calling a new runtime supported. Scope evidence to game content, runtime/version, profile and host/browser identity. Keep player observations distinct from automated checks. Model readiness/WebGPU says nothing about game execution.
