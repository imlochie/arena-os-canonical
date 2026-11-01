---
name: Arcade model routing
description: Why game generation and revisions must not silently try unrelated public AI services.
---

Arcade generation and source-based modifications must use a connected provider or a loaded on-device model. When neither is available, report the missing model directly rather than trying unrelated public endpoints or substituting a preset game.

Manual game editing, static validation and local packaging must remain usable
without a model or hosted owner session. Only explicit model missions need the
authenticated source handoff.

**Why:** Local work should not be blocked by an unavailable model or preview
login, and static inspection does not justify uploading private game source.

**How to apply:** Keep parser-only checks local. Never weaken owner API guards
to make browser-local development tools usable.

Arcade should offer both free on-device code models and an explicit credit-based Replit AI route, while keeping other sourceable providers opt-in. REA is a local reverse-engineering MCP toolkit, not a game-writing model.

**Why:** The user requested both local and Replit-credit model options and named REA as a source to evaluate.

**How to apply:** Keep provider choice explicit; treat REA as an optional analysis tool only, not as an inference backend.

REA game analysis is opt-in and limited to games the user owns or is authorized to inspect. It is static analysis, never game execution or a game-writing model; disclose any source transfer and keep findings separate until the user reviews them.

**Why:** The user chose REA as an optional analysis aid, not a substitute for local generation, and Arcade imports may contain private or copyrighted source.

**How to apply:** Never analyze on import. Require an explicit authorization and action, do not persist the report, and do not silently pass its contents to a model.

**Why:** Public endpoint cascades can leave custom game requests waiting for multiple timeouts. Revisions also contain the existing game source, which should not be sent to a service the user did not choose.

**How to apply:** Keep classic quick starts separate from custom mechanics. Preserve the current game and the requested change when a modification cannot run. Connecting or changing a provider must be an explicit user action.

Imported ROMs and browser-game HTML stay in browser-local storage; do not place them in the shared Arcade game catalog, whose read path is public. Only an explicit prompt revision may send browser source to the selected model, and that request must remain ephemeral. Imported code must run in a separate restricted runtime rather than relaxing generated-game validation.

**Why:** User-owned imports can be copyrighted or private source; storing them in the shared catalog would expose them to other users.

**How to apply:** Keep file bytes on-device by default. Make any model handoff clear at the point of use, avoid server persistence, and preserve the generated-game validator.

Every prompt-generated or imported game must retain meaningful per-game progress across reloads. Revisions should keep the same save identity, and users need a clear/reset action.

**Why:** The user explicitly made saved progress a core completion requirement.

**How to apply:** Persist saves locally under a stable game identity and verify both reload and revision paths; do not rely on transient component state.

Offline starter presets are optional, editable local-library games, not replacements for AI prompt generation or user imports. Prompt revisions must act on the saved local source without publishing it to the shared catalog.

**Why:** The user asked for the former presets back as saved offline games they can build on, not a preset-only game catalogue.

**How to apply:** Preserve the local game identity and save slot through revisions; route changes through the selected model and leave the saved original intact if revision fails.

Do not claim local game generation works based only on WebGPU detection or successful model loading. A real prompt must generate HTML, pass Arcade validation, and start in the isolated game preview on the target browser.

**Why:** The user called out prior assurances based on readiness checks that did not prove actual local generation.

**How to apply:** Treat the on-device generation check as device-specific evidence; a headless browser without WebGPU must report “not verified,” never pass.

WebGPU API exposure is not proof that an adapter is usable: Chromium can leave `navigator.gpu` present while `requestAdapter()` returns no adapter. Also distinguish a minimal local-generation smoke prompt from representative game-quality testing.

**Why:** Chromium 152 exposed the API in a local preview with GPU/WebGPU disabled, while the small CPU model passed Arcade's focused game check but failed a more demanding Pong prompt.

**How to apply:** Check adapter availability, then separately verify source validation and isolated startup. Report the prompt and model used; a minimal smoke pass proves the route works, not that every custom game prompt will succeed.

Model backend labels are a runtime contract. Keep model selection, Local Mode routing, the local-model proof action, cancellation, and runtime provenance aligned for every server-routed local backend. Restrict local inference to loopback and never disguise an unreachable model as generated game code.

**Why:** A catalogued TurboAgent model was being routed differently from Model Hub models: Local Mode chose the WebGPU path, and the local proof control did not recognize it.

**How to apply:** For each local backend, test a real loopback inference request, refusal of a non-loopback URL, upstream cancellation, and the browser flow; do not count a mocked browser response as model-generation evidence.
