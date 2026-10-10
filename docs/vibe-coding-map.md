# The Vibe-Coding Tools Map — deep dive, comparison, and integration

Mandate: the 10 vibe-coding tools (Google AI Studio, Lovable, Bolt.new,
Replit, v0, Cursor, Windsurf, Firebase Studio, Base44, Copilot) plus the tail
links (Warp, aifaceswap.io, agpt.co, Mistral Small 4, LTX desktop,
UI-TARS-desktop) — same treatment as the 13-tools map: study the open-source
counterparts, compare honestly with Arena OS, and integrate what's real.

**What shipped across the waves:**
- **App Foundry** (`/foundry`) — the in-app vibe-coding surface, now
  full-stack via the sandboxed `window.arena.kv` bridge (Wave 3).
- **Deep Agent** (`/deep-agent`) — bounded plan → act → verify (Wave 3).
- **Repo map** — live codebase context for every assistant surface (Wave 3).
- **Shorts/dubbing/Studio templates/yt-dlp ingest** — the 13-tools Wave 3
  items (see the list below).
- **Mistral Small BYOK** — remote-tier key (`KeysBar` → `mistral`).
- Re-clones #20/#21 healed by `scripts/environment-restore.mjs` (the
  standard recovery path, hardened in this wave).

## The map

| # | Tool | Essence | Open-source counterparts (studied) | Arena OS answer |
|---|------|---------|-------------------------------------|-----------------|
| 1 | Google AI Studio | prompt playground → prototype | (closed) — local: any WebUI | Chat / Council / Model Hub already are this, local-first |
| 2 | Lovable | NL → full-stack app | **gpt-engineer** (MIT), bolt.diy | **App Foundry (shipped)** — describe → build → iterate; server-side execution deliberately excluded (safety), so v1 is frontend apps; full-stack = Wave 3 with the tool-effect approval chain |
| 3 | Bolt.new | in-browser dev env, instant run | **bolt.diy** (Apache-2.0, WebContainers) | Foundry's sandboxed iframe preview = the local equivalent (allow-scripts, no same-origin, injected no-network CSP) |
| 4 | Replit | hosted IDE + agent + deploy | **OpenHands** (ex-OpenDevin, MIT) | Agent Bridge (`scripts/agent-bridge.mjs`) is the terminal-agent seam; autonomous loops = Wave 3 (bounded, approval-gated via existing `toolEffects`) |
| 5 | v0 | NL → modern UI | shadcn-style generators (closed core) | Foundry generates complete dark-theme documents; design-system scaffolds = Wave 3 polish |
| 6 | Cursor | codebase-aware editor | **Continue.dev** (Apache-2.0), **Aider** (Apache-2.0), Tabby | Codebase context: `assistantTools.ts` PLATFORM_MODULES/DOCS feeds every surface already; repo-map context pack = Wave 3 |
| 7 | Windsurf | agentic IDE workflows | Cline / Roo Code (Apache-2.0) | Same as 4 — bounded agent + bridge |
| 8 | Firebase Studio | browser full-stack env + BaaS | Supabase local, PocketBase (MIT) | The app *is* the local BaaS (Postgres + jobs + artifacts); Foundry is the build surface |
| 9 | Base44 | NL → working app, no setup | gpt-engineer again | **Foundry (shipped)** — zero-setup by design |
| 10 | GitHub Copilot | in-editor completions/fixes | Continue, Tabby, llama.vim | Outside Arena's surface (it's an editor feature); the Council/Collab surfaces cover review/refactor workflows app-side |

## The tail links

| Link | What it is | Arena OS disposition |
|------|-----------|---------------------|
| warp.dev | agentic terminal | Concept = Agent Bridge (shipped earlier); a Warp-like TUI wrapper over the bridge is a natural Wave 3 |
| aifaceswap.io | face swap | Open-source: **ReActor / insightface inswapper** (ComfyUI nodes), **FaceFusion**. Personal-use OK per mandate rules; Wave 2+ as a Studio ComfyUI workflow template (owner-side GPU — never faked here) |
| agpt.co | AutoGPT | AutoGPT itself is MIT. Arena's honest version of "autonomous": bounded agent loops with the existing propose/approve/apply tool-effect chain (no unbounded self-prompting). Wave 3 |
| Mistral Small 4 | Apache-2.0 open-weights model | **Shipped**: BYOK remote tier (`mistral-small-latest`, request shape unit-tested); also pullable via Ollama (`mistral-small3.2`, ~14 GB) for fully-local Foundry builds — Model Hub supports any tag |
| ltx.io/ltx-desktop | Lightricks' local video desktop | Studio already speaks **LTX-2** (catalog `ltx2_22B_distilled_1_1`, ComfyUI-native) — the local-desktop-video-story is ours already |
| UI-TARS-desktop | ByteDance GUI agent (Apache-2.0) | The app has Playwright in-repo; a browser-agent surface (vision-model-driven UI automation) = Wave 3+ exploration, clearly experimental |

## App Foundry — what it is, exactly

- **Describe → build**: `POST /api/foundry {action:"create"}` → any model in
  the app (Local Engine floor, Model Hub local-server, BYOK keys, keyless
  remote) generates ONE self-contained HTML document.
- **Iterate**: `action:"iterate"` sends the current code + the change; failed
  generations keep the previous working version (never a regression).
- **Honesty**: every stored version records `engine`/`via`/`fallback`. With
  only the Local Engine you get the labeled offline scaffold — a real,
  working starter app, clearly marked "not model output".
- **Safety** (the part Bolt/Lovable can't give you by design):
  - generated code never executes server-side;
  - preview iframe: `sandbox="allow-scripts allow-forms allow-modals"` — no
    `allow-same-origin`, so it cannot touch the app's origin or storage;
  - we inject `Content-Security-Policy: default-src 'none'` (inline
    script/style only, `data:`/`blob:` media) — no network calls, no
    exfiltration, no CDN dependence; truly self-contained apps;
  - versions live in Postgres (`foundry_apps` / `foundry_versions`,
    migration `0010_foundry.sql`) with cascade delete.
- **UI**: `/foundry` — app list, prompt, live preview, code view, download
  `.html`, version/engine labels, Rooms card + launcher entry.

## Wave 3 — SHIPPED (see "What shipped" at top for the wave summary)

1. **Full-stack Foundry apps** — DONE. The sandboxed preview gets a
   `window.arena.kv` API (postMessage to the parent page →
   `/api/foundry/[id]/data`): strictly app-scoped, capped (64-char keys,
   32KB values, 200 keys, 2MB/app), cascade-deleted with the app. No
   arbitrary file/system writes by design — that remains the tool-effect
   approval chain's job.
2. **Bounded autonomous agent** — DONE, as `/deep-agent` (Rooms "Automate"):
   plan → act → verify with capped steps (≤8), a ~110s budget, one retry per
   failed step, full transcript persisted (deep_agent_runs/steps), honest
   engine labels. It researches and drafts; it never writes outside its runs.
3. **Repo-map codebase context** — DONE: `src/lib/repoMap.ts` walks the live
   tree (898 files) → `/api/repo-map` + the `repo_map` assistant tool, so
   every assistant/chat surface can answer "where is X implemented" from
   ground truth.
4. **Studio + creative Wave 3** — DONE: RMBG background-removal + ReActor
   face-swap + ACE-Step song ComfyUI templates (owner-side GPU, honest
   requirements stated); captioned Shorts (audio → waveform MP4 with
   BURNED-IN subtitles — real ffmpeg, proven live); dubbing pipeline
   (transcribe → translate → speak, per-stage honesty).
5. **ACE-Step song generation** — the Studio template + workflow shipped
   (audio modality); pulling the checkpoint is owner-side (HF blocked in
   sandbox).
6. **Personal ingest (yt-dlp)** — DONE: `POST /api/library/ingest` runs the
   REAL library intake (checksum → dedupe → separation queue) on yt-dlp
   output; honest 503 with install guidance when absent (proven live).
