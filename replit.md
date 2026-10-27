# ArenaForge Personal

A private, local-first AI workspace with blind model battles, chat, collaborative workflows, creative tools, and Waveyard music production.

## Run and verify

- Frontend: managed workflow `artifacts/arenaforge: web`, preview `/`.
- Backend: managed workflow `artifacts/api-server: API Server`, API prefix `/api`.
- Browser smoke test: `node scripts/arena-smoke.mjs` (also registered as validation `test`). Requires both workflows running and Chromium at `/repl/tools/bin/chromium`, or `CHROMIUM_PATH`.
- Runtime/privacy unit checks: `pnpm --filter @workspace/scripts exec tsx --test ../lib/arena/src/lib/security/local-request-gate.test.ts ../lib/arena/src/lib/security/loopback-host.test.ts ../lib/arena/src/lib/runtime.test.ts`.
- Development schema: `pnpm --filter @workspace/db run push`.
- Replit supplies `DATABASE_URL`. `SESSION_SECRET` remains server-only.

## Structure

- `artifacts/arenaforge/src/app/`: preserved route views; `src/routes.ts` maps all original page URLs.
- `artifacts/arenaforge/src/components/`: original UI; `src/app/globals.css` and `src/app/waveyard/waveyard.css` preserve its design.
- `artifacts/api-server/src/imported/`: original API logic converted to standard Web Request/Response handlers.
- `artifacts/api-server/src/routes/imported.ts`: Express adapter for streaming, multipart, range responses, aborts, and same-origin mutation protection.
- `artifacts/api-server/src/page-data/`: database/bridge data formerly loaded by server-rendered detail pages.
- `lib/arena/`: shared imported business logic, provider integrations, SQL history, and bridge source.
- `lib/db/src/schema/`: original Arena, identity, college, and Waveyard database definitions.
- `.migration-backup/`: untouched original reference, excluded from deployment.
- `generated-artifacts/arena-smoke/`: ignored browser evidence and report.

## Product constraints

- Preserve the existing interface and behaviors during this port. Do not replace original tools with explanatory placeholders.
- The built-in Local Engine is deterministic, **not an LLM**. Keep its execution/fallback metadata honest, and do not move model Elo for local-engine/fallback battles.
- Local Mode must make no outbound AI calls. Optional BYOK credentials live in the browser and are sent only per request; never store them in the database.
- Before a battle is voted on, all browser-facing endpoints must hide model and assistant identities.
- WanGP integrations require attribution: “powered by WanGP (Wan2GP) by DeepBeepMeep”.
- The user prioritizes working flows over more descriptions of what each tool is intended to do. Suggestions for rooms must become capabilities, not just presets; existing capabilities must be reachable through usable controls.
- As of 2026-10-27, Waveyard and Arcade are the user's main priorities. For these products, code quality and passing tests do not prove the experience matches their intent; use the actual experience and the creative direction they state as the standard. Ask before making major directional changes when that intent is unclear.
- Waveyard's target is a stem.fm replacement with extra capabilities; make the path from source audio through separation, remixing, and the next creative step feel like one coherent session rather than disconnected UI stages.
- Arcade's target is prompt-driven emulation, creation, and modding of arbitrary games. Treat presets as optional starting examples, never the ceiling; the prompt workflow must produce playable, editable games.
- Spaces must provide “automated browser tasks in its own workspace.” A task preset alone does not satisfy this requirement.

## Scope and limits

This migration targets the Replit web runtime. The original Windows/Electron packaging source is retained in the backup, but no Windows installer has been built or verified here. External local-model servers, GPU bridges, and WebGPU model downloads still require their real runtime resources. Passing the web smoke tests is not evidence that those tools or the Windows desktop build work.

File-backed features retain their original local storage providers; Replit's server filesystem is not the user's Windows filesystem. No existing remote database contents were imported.

Strict type cleanup of imported code is outside the port scope. Verify runtime behavior and artifact builds; do not claim the full monorepo typecheck is clean.
