---
name: Arena Everywhere expectations
description: Console expansion scope and evidence requirements from the user's mission brief.
---
Arena is one ecosystem with device-specific shells, not independent products.
The initial console targets are Nintendo 3DS, Switch and Wii. Shells should
feel native and support useful offline operation without a desktop host.

**Why:** The user supplied the Arena Everywhere mission and explicitly asked
for architectural investigation before implementation or superficial mockups.

**How to apply:** Audit existing identity, storage, Arcade, mod and agent
boundaries before introducing a shared Core abstraction. Reuse established
services without assuming desktop technologies or executables run on consoles.
Select one initial native shell based on tooling and available hardware, then
demonstrate real controls, launching, persistence, recovery and supported mods.
Distinguish implemented/tested, unverified, partial, planned and blocked support;
metadata portability is not executable or save-format compatibility.
