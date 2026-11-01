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

Native Windows execution must fail closed when real OS containment cannot be verified; a Job/process tree alone is not a filesystem/network sandbox.

**Why:** Imported native code is a different trust boundary from browser games. Linux protocol simulations and a successful process spawn cannot establish Windows isolation or SDL/audio compatibility.

**How to apply:** Keep hosted execution unavailable. Require actual target-host evidence before claiming support, and distinguish hard process/CPU/memory limits from a best-effort disk reserve. Deliver independent native packages with the exact installer catalog that pins their bytes.

Treat a stopped native build's output tree as untrusted before privileged postprocessing.

**Why:** An isolated editor script can plant junctions or hard links that make the owner process escape the sandbox when it later copies assets or writes provenance.

**How to apply:** Stop all owned descendants first, then reject links/reparse points in writable-root ancestors and contents before any owner-side output traversal or write. A trusted compiler executable does not make repository-produced filesystem entries trusted.
