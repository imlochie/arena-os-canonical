# AGENTS.md

> Orientation for AI coding agents working in this repository.
> Deep dives: [`STUDIO.md`](./STUDIO.md) (multimodal Studio) · [`REFERENCES.md`](./REFERENCES.md)
> (curated open-source map — upstream repos, licenses, agent patterns) · [`bridges/README.md`](./bridges/README.md).

## What this project is

**ArenaForge Personal** — a personal, $0, local-first AI arena ("Arena OS"): blind LLM
battles with ELO ratings, Council/Collab multi-model workflows, projects/artifacts/memory,
an offline arcade, direct chat, and a multimodal **Studio** (video/image/audio) that drives
WanGP (Wan2GP by DeepBeepMeep) via a local bridge, any ComfyUI server, an optional BYOK
cloud API, or a fully-local demo engine.

Stack: Next.js (App Router) + TypeScript + Tailwind v4 + Drizzle ORM + PostgreSQL.

## Commands

| Action | Command |
| --- | --- |
| Install | `npm install` |
| Dev server | `npm run dev` (needs `DATABASE_URL` in `.env`; app still runs if DB is down) |
| Build | `npm run build` |
| Lint | `npm run lint` (baseline has ~20 pre-existing errors; don't add new ones) |
| Typecheck | `npx tsc --noEmit` (must pass) |
| DB push | `npx drizzle-kit push` (config: `drizzle.config.json`) |
| WanGP bridge (test w/o GPU) | `python3 bridges/wangp_bridge.py --mock` → http://127.0.0.1:7862 |

## Repo map

```
src/app/          pages + /api routes (route.ts files are thin; logic lives in src/lib)
src/components/   client components (BattleArena, StudioLab, CutLab, CouncilLab, …)
src/lib/          all business logic (ai.ts provider fan-out, elo.ts, collab.ts, …)
src/lib/studio/   multimodal generation: types, catalog, wangp, comfyui, hosted, demo, jobs
src/lib/cut/      browser video editor: types, render, exporter, projects (see CUT.md)
src/db/           drizzle client + schema.ts (source of truth for tables)
drizzle/          SQL migrations (studio_jobs & cut_projects also auto-create at runtime)
bridges/          wangp_bridge.py — stdlib-only HTTP bridge over WanGP's shared/api.py
STUDIO.md         Studio architecture, backend setup, settings mapping
CUT.md            Cut Lab (browser-native video editor) guide
CONGRESS.md       Congress (timed multi-seat deliberation) guide
SPACES.md         Spaces (multi-window recurring agent workbench) guide
ARCHIVE.md        Archive Assistant (chat agent with tools + archive index) guide
REFERENCES.md     open-source resource map (upstreams, licenses, agent patterns)
```

## Non-obvious conventions

- **Fallback-first**: every feature must keep working when its best resource is gone
  (no DB → in-memory/static fallbacks; no GPU → demo engine; no network → Local Mode).
  New code follows `try { … } catch { degrade }` patterns, never hard failure.
- **Privacy contract**: outbound AI calls send `NO_TRAIN_HEADERS` (`src/lib/privacy.ts`);
  egress only happens with explicit user action (BYOK keys); log metadata-only privacy
  events via `logPrivacyEvent`. Never persist prompt/key content server-side.
- **BYOK keys live in the browser** (localStorage, `af_key_*` / `af_studio_*`) and are
  passed per-request (body or `x-studio-*` headers). Never store them in the DB.
- **WanGP attribution is required** (its terms): any UI/docs touching the `wangp` backend
  must disclose "powered by WanGP (Wan2GP) by DeepBeepMeep".
- **Model registry**: `FREE_MODELS` in `src/lib/models.ts` is the static catalog, synced
  into the `models` table by `ensureSeeded()` (best-effort). Studio models live in
  `src/lib/studio/catalog.ts` (offline fallback) or come live from the bridge. Special
  `pollinationsId` prefixes: `__offline__` (local generator), `__image__:` (URL image gen),
  `__turboagent__:<hf-id>` (local TurboAgent server via `keys.turboagent` URL or
  `TURBOAGENT_URL`; probe at `/api/turboagent/health`).
- **Ratings**: simple online Elo (K=32) in `src/lib/elo.ts`; per-category table
  `model_category_ratings`. (REFERENCES.md §7 lists upgrade paths.)
- **Client components** hydrate localStorage in `useEffect` — the codebase accepts the
  associated lint warning; don't restructure pages just to silence it.

## Studio specifics (if touching `src/lib/studio/` or `/api/studio/*`)

- Four backends behind one interface: `wangp` (bridge) · `comfyui` · `dashscope` (BYOK) ·
  `demo` (procedural, deterministic from prompt+seed).
- Jobs persist to `studio_jobs` with an in-memory fallback (`src/lib/studio/jobs.ts`).
- Media is always proxied through `/api/studio/jobs/{id}/media?f=…` with HTTP Range.
- ComfyUI workflows are API-format JSON with `{{PROMPT}}/{{SEED}}/{{WIDTH}}/…` tokens
  (`src/lib/studio/comfyui.ts`).
- The bridge contract mirrors WanGP's official API (`docs/API.md` in the WanGP repo);
  test with `--mock` before assuming WanGP behavior.

## Verification before "done"

1. `npx tsc --noEmit` — clean
2. `npm run build` — succeeds (needs `DATABASE_URL` set, e.g. in `.env`)
3. `npm run lint` — no **new** errors vs baseline
4. Exercise new API routes with `curl` against `npm run dev`
5. Studio changes: test the demo backend (always available) and, if backend-related,
   the mock bridge / a mock ComfyUI

## Hard rules

- Never commit secrets, API keys, or `.env` (gitignored).
- Never push generated artifacts or large model files into the repo.
- Keep new dependencies to zero unless explicitly justified.
- Migrations: add SQL under `drizzle/` **and** the matching table in `src/db/schema.ts`.
