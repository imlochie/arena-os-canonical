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

Linux admission must test a real private-proc sandbox setup, not infer viability from successful namespace creation or cgroup access.

**Why:** The hosted environment allowed namespace creation and independent resource controls but refused mounting fresh procfs inside the sandbox. Advertised facilities initially concealed the execution blocker.

**How to apply:** Recheck the actual target host. Never bind the owner's existing procfs or weaken containment to bypass a failed admission test. Treat tool/version detection as separate from executable game support.

Use a disposable Linux CI runner for the next Linux compatibility execution verification, rather than asking for an owner-machine run.

**Why:** The user selected Linux CI after the hosted private-proc restriction was demonstrated; Windows testing remains deferred to the final pass.

**How to apply:** Prepare and run the CI path when repository access permits. Do not treat CI admission success as gameplay or Windows evidence.

Native Windows execution must fail closed when real OS containment cannot be verified; a Job/process tree alone is not a filesystem/network sandbox.

**Why:** Imported native code is a different trust boundary from browser games. Linux protocol simulations and a successful process spawn cannot establish Windows isolation or SDL/audio compatibility.

**How to apply:** Keep hosted execution unavailable. Require actual target-host evidence before claiming support, and distinguish hard process/CPU/memory limits from a best-effort disk reserve. Deliver independent native packages with the exact installer catalog that pins their bytes.

Treat a stopped native build's output tree as untrusted before privileged postprocessing.

**Why:** An isolated editor script can plant junctions or hard links that make the owner process escape the sandbox when it later copies assets or writes provenance.

**How to apply:** Stop all owned descendants first, then reject links/reparse points in writable-root ancestors and contents before any owner-side output traversal or write. A trusted compiler executable does not make repository-produced filesystem entries trusted.

DOS games need a writable working game copy, not just a read-only asset drive and an empty save drive.

**Why:** Many DOS programs read assets relative to the working directory and mix progress with original files. Assuming they accept an independent save directory creates a fixture-only integration that fails real games.

**How to apply:** Keep the immutable installation separate from each isolated profile's working copy. Preserve game-written changes across launches/runtime updates. Require an explicit new profile for conflicting source changes rather than guessing which modified assets are progress.
