# Arena Branch Convergence Audit

> **Date:** 2026-10-05 · **Auditor:** Arena session `arena/01a10c30-arena-os-canonical`
> (agent-assisted, owner-directed) · **Mission:** owner-issued convergence audit —
> establish which branch is the actual current product, what is experiment/gate/superseded,
> the intended ancestry, the latest coherent integration point, what must be preserved,
> and what still blocks "just use Arena" — then pick **one canonical baseline**.
> **Read-only with respect to all audited refs.** No merges, rebases, deletions, or
> force-pushes were performed. The only artifact of this pass is this record, committed
> to the audit session branch.
>
> Categories: **CURRENT FACT** (git-proven, command-cited) / **INFERENCE** (follows from
> facts, labelled) / **OWNER DECISION REQUIRED**.

---

## 0. Executive verdict

| Question | Answer |
|---|---|
| Which branch contains the actual current product? | The product core is the **`main` hub tree (`c1c1219`)** — the "verified historical contract" every later session treated as the parent. The newest owner-stated expression of the product is **`arena-rooms-handoffs` (`1077e3a`)**: that same hub plus the owner's own rooms map and draft handoff ledger. |
| Which branches are experiments / gates / superseded? | `arena/01a09640` (tool-runtime & identity design capital), `arena/01a0a9b7` (feature-surface buffet, partially superseded), `arena/01a0b544` (governance/evidence capital, deliberately read-only), `arena/01a0bb55` (a *separate product concept* — the College — with the best production discipline), `arena/01a0bdc9` (independent LUMA surface). None is superseded in the sense of deletable — all are preserved slices. |
| What is the intended ancestry? | Layered: hub (`main`) → tool runtime/identity (`9640`) → orchestrator/surfaces (`a9b7`) → rooms. **Actual ancestry: flat.** All seven branches are siblings off `c1c1219`; nothing was ever merged back. Later briefs describe a composite tree that exists nowhere (§3.2). |
| Latest coherent integration point? | **`arena/01a0bebf` (`b690d99`)** is the deepest *coherent* integration (hub restored + Waveyard room + rooms/handoffs + Docker/CI/E2E), with Arena-side runtime gates still open per its own recovery audit. **`arena-rooms-handoffs` (`1077e3a`)** is the latest *owner-authored* integration point — minimal, additive, honest. |
| What must be preserved? | Every branch — each is the only home of its slice (§5, Appendix B). Plus: the recovery/compatibility decisions in `bebf`'s `docs/RECOVERY_AUDIT.md`, the gate/lab records in `b544`, the deployment + health-check discipline in `bb55`, and `main`'s contract itself. |
| What still genuinely blocks "just use Arena"? | For the hub baseline: nothing structural — Node 22 + `DATABASE_URL` and it runs; LLM features need BYOK/local keys. The real blocker is **integration discipline**: 214 commits across seven session branches, zero merged, one stale PR, and briefs referencing an Arena that exists on no branch (§6). |

**Recommendation (§5):** ratify **`arena-rooms-handoffs` (`1077e3a`)** as the canonical Arena
baseline, preserve `bebf` as the Waveyard room integration to mount second, fast-forward
`main` to the baseline, and freeze the merry-go-round: after the baseline crosses the
usage threshold, no new parallel session branches — new work lands as rooms/PRs on the
baseline.

---

## 1. Lineage pre-flight

All refs verified against the live remote at audit time (`git ls-remote --heads origin`),
then fetched and inspected locally. Three-way agreement (remote / local ref / worktree
under audit) held throughout.

| Ref | Verified tip | First commit | Last commit | Commits vs `main` | Authored |
|---|---|---|---|---|---|
| `main` | `c1c12190` | — | 2026-09-13 01:28 | 0 | owner |
| `arena/01a09640-arena-os-canonical` | `c8e5eb6` | 09-13 15:53 | 09-14 09:32 | 16 | agent (16/16 co-authored) |
| `arena/01a0a9b7-arena-os-canonical` | `e60e359` | 09-16 10:49 | 09-16 17:58 | 12 | agent (12/12) |
| `arena/01a0b544-arena-os-canonical` | `53b5ca0` | 09-18 16:48 | 09-19 19:09 | 51 | agent (51/51) |
| `arena/01a0bb55-arena-os-canonical` | `5fcb4d7` | 09-19 21:07 | 09-20 06:53 | 23 | agent (23/23) |
| `arena/01a0bdc9-arena-os-canonical` | `c6b4527` | 09-20 08:20 | 09-20 11:05 | 10 | agent (10/10) |
| `arena/01a0bebf-arena-os-canonical` | `b690d99` | 09-20 12:23 | 09-29 19:06 | 101 | agent (65) + recovered Waveyard lineage (36, owner) |
| `arena-rooms-handoffs` | `1077e3a` | 09-30 02:41 | 09-30 02:41 | 1 | **owner (0 agent co-authorship)** |

Other remote state: **no tags, no releases**, exactly one pull request ever —
**PR #1** (`arena/01a0a9b7` → `main`, "Add Studio: multimodal generation…", opened
2026-09-16T10:49:22Z, still OPEN, `MERGEABLE`, no status checks). The PR's title
describes its *first* commit; its head now carries all 12 commits of a far wider
surface. **CURRENT FACT: the PR is stale as titled but clean as a merge.**

### 1.1 The one-line ancestry finding

`git merge-base` for **every pair** of the seven branches — and of each against `main` —
resolves to `c1c1219`. **CURRENT FACT: the branches share exactly one common ancestor and
zero cross-merges. Every session started fresh from `main` and nothing ever landed back.**
The 214 session commits exist on seven parallel lines.

### 1.2 The sessions are sequential, not concurrent

First/last commit times show each branch beginning hours after the previous one ended
(`9640` 09-13→14 · `a9b7` 09-16 · `b544` 09-18→19 · `bb55` 09-19→20 overnight ·
`bdc9` 09-20 morning · `bebf` 09-20→29 · `rooms-handoffs` 09-30). **INFERENCE:** this is
not seven competing visions; it is seven consecutive work sessions, each of which
*re-derived* what "Arena" is because the previous session's work was never integrated.

---

## 2. Branch inventory and classification

### `main` — `c1c1219` — the product core ("verified historical contract")

Next.js 16 + Drizzle + PostgreSQL personal AI hub ("ArenaForge Personal" in its own
agent docs): 19 surfaces — home, command, battles (blind LLM + ELO), council, collab,
chat, assistants, projects (+memory), artifacts, image, arcade, leaderboard, market,
guide, principles, standards, privacy — plus workforce roles, prompt templates,
privacy audit controls, local/BYOK model paths. Single migration
(`0008_cognitive_sessions.sql`). No README on the tree.

- **Classification: the actual current product base.** Every later session — including
  the Waveyard recovery audit — independently re-verified this tree as the parent
  contract (`bebf:docs/RECOVERY_AUDIT.md`, "Verified historical Arena contract").
- Note: `main` is 3 weeks stale relative to everything below; it is the *contract*, not
  the *state of the art*, of the repo.

### `arena-rooms-handoffs` — `1077e3a` — the owner's own baseline statement (NEWEST TIP)

One commit, directly on `c1c1219`, **the only branch in the repository with no
arena-agent co-authorship**. Adds 10 files / 1,131 lines, all under `src/`
(no dependency, config, or schema changes — it runs exactly as `main` runs):

- `src/lib/arenaRooms.ts` — a 12-room directory over *existing* hub surfaces
  (Assistant→`/assistants`, Orchestrator→`/command`, Council→`/council`,
  Spaces→`/projects`, Archive Assistant→`/artifacts`, Classroom→`/guide`,
  Studio→`/collab`, LUMA→`/image`, Device Security→`/privacy`), each with an
  **honest state**: `available` / `local` ("No service connected" — Congress, Cut Lab,
  Waveyard) / `approval`.
- `src/lib/arenaHandoffs.ts` + `/handoffs` page — an explicit local **draft** handoff
  ledger (localStorage, validated reads/writes, queued/reviewed states).
- `/rooms` + `/rooms/[roomId]` pages, home-page and nav entry points.

**CURRENT FACT: this commit is a convergence audit expressed as code.** It names the
rooms, maps each to what actually exists, and refuses to claim services that are not
connected. It was committed ~7 hours after `bebf`'s tip, whose final commit is
"feat(arena): add rooms discovery and local draft handoffs" — the same concept,
distilled by the owner onto the clean hub baseline instead of the Waveyard monorepo.

### `arena/01a0bebf` — `b690d99` — the deepest coherent integration (Waveyard session)

101 commits over 9 days. Arc, from its own records: Phase-0 reconnaissance
(09-20) classified the repo as *unrelated* to a planned stem-separation platform and
rebuilt it as the **Waveyard** monorepo (`apps/web`, `apps/worker`,
`packages/{audio,auth,database,queue,storage,types,ui}`, Docker Compose, worker,
CI workflow, E2E suite). On 09-28 the **recovery audit** established the predecessor
was the verified Arena parent all along, and reversed course without history surgery:
hub restored and namespaced (`arena_*` tables, `/api/arena/*` routes, historic rooms at
historic surfaces), Waveyard mounted at `/waveyard`, cross-room work via an explicit
`arena_room_handoffs` adapter, original Waveyard history preserved via a non-destructive
`ours` merge (`361cfc5`). Final commit adds rooms discovery + local draft handoffs
inside the monorepo.

- Hub fidelity vs `main`: of `main`'s 100 `src/` files — 32 byte-identical, 31 adapted
  (namespaced API clients, room nav), 37 relocated (schema → `packages/database`, etc.).
- Verified by its own gates: 112 unit tests, a seven-test local Docker Compose gate
  (Phases 2–4), real Demucs `prove:demucs` acceptance, and an E2E push (09-28→29)
  fixing remix hydration/automation persistence.
- **Its own recovery audit lists the Arena-side gates still OPEN:** `arena_*` migrations
  against a real PostgreSQL instance; integration/E2E for cross-room handoff and Arena
  navigation; extending the Compose topology to apply Arena migrations.
- **Classification: the deepest verified integration and the Waveyard room — not the
  daily-driver baseline.** Runtime topology is PostgreSQL + Redis + MinIO + worker +
  (for real audio) FFmpeg/PyTorch/Demucs.

### `arena/01a0bb55` — `5fcb4d7` — the College: a second product, the best discipline

23 commits in one overnight session: "Lochie Life College" institutional runtime,
Layers 2–9 (faculty attention/coordination, executable teaching loop, governance,
commitments, simulated-clock timetable, campus UI, iOS client, auth, deployment,
hardened health check). Verified counts in the tip commit: 17/17 L9, 22/22 L8, 20/20
L7, 28/28 L6; production build verified; idempotent migration runner reaching 78 tables.

- The health-check hardening (`5fcb4d7`) encodes a generalizable production rule:
  unsafe dev-auth on a public interface returns **503 with named consequences**, not a
  200 with a warning field. "Being loudly broken is safer than being quietly open."
- Its architecture doc's own critical finding (§0) states the build brief described
  sessions/workforce/**tool runtime**/**orchestrator**/archive-truth-plane — and
  "most of that does not exist in this repository."
- Its migrations **re-baseline** drizzle history (`0000_college_baseline.sql` alongside
  `0008_cognitive_sessions.sql`) — converging it with `main`'s history is a deliberate
  adoption decision, not a merge.
- **Classification: a separate product concept built with the strongest production
  discipline; not the Arena hub baseline; the deployment/health-check patterns are
  portable assets.**

### `arena/01a0b544` — `53b5ca0` — gates, labs, and the AA seam (read-only capital)

51 commits of governance and evidence work: Gates 5–8, reasoning labs 001–004, the
lab-004 decision record (owner-ratified 2026-09-20), and a personalisation/archive
reasoning seam in `src/` (`src/lib/personalisation`, `src/lib/archive-reasoning`,
archive context APIs) — a **GET-only client to the external Archive Assistant
("AA") repo**, pinned at `imlochie/SomeSafePortablesoftware@1a2200b`. The tip (Gate 8)
is explicitly "read-only, no implementation" and holds implementation until AA answers
its Q1–Q4.

- **Classification: institutional memory + a seam to an external system.** It is design
  and verification capital, not a product baseline. Its docs are mergeable as docs,
  independently of any code.

### `arena/01a0a9b7` — `e60e359` — the feature-surface buffet

12 commits in a single day (09-16): Studio (multimodal gen: WanGP bridge/ComfyUI/BYOK/demo),
Cut Lab (browser video editor), TurboAgent (local text backend), Congress (timed
multi-seat deliberation), Spaces (multi-window recurring workbench), Archive Assistant
(in-app agent over platform + archive index), Orchestrator (collaboration bus),
College classroom (early slice), plus AGENTS.md/REFERENCES.md orientation. Extends
drizzle to `0016`. Source of PR #1.

- **Classification: the surface layer of the *intended* product, partially superseded:**
  classroom → superseded by `bb55`'s College; Archive Assistant → superseded in
  direction by `b544`'s external-AA seam; Studio/Cut Lab/Congress/Orchestrator →
  never integrated anywhere. The owner's rooms map (09-30) points "Studio" at the
  existing `/collab` and marks Cut Lab "not connected" — an implicit verdict on how
  much of this is currently *product*.

### `arena/01a09640` — `c8e5eb6` — the tool runtime & identity foundation

16 commits (09-13→14): canonical architecture docs (tool runtime, product architecture,
threat model), scoped read-only tool runtime with atomic effect approval, persisted
approved effects, owner/device identity, secure device artifact channel, worker
retry/fallback semantics. Extends drizzle `0009`–`0026`.

- **Classification: ratified design + implementation capital for the layer every later
  brief assumed existed.** Never landed; no branch contains it except this one.

### `arena/01a0bdc9` — `c6b4527` — LUMA (independent surface)

10 commits (09-20 morning): a camera-first photography app (Expo/RN/TS) in an isolated
`luma/` directory + two `src/` files (a `/luma` page and a nav link). Near-total
additive isolation. **Classification: an independent creative surface; trivially
preservable; the owner's rooms map currently points "LUMA" at the existing `/image`
workflow instead.**

---

## 3. The ancestry question

### 3.1 Intended ancestry (from the repo's own records)

- `9640`'s architecture doc (09-13) defines the layering: Cognitive Session →
  Workforce (reasoning) + Tool Runtime (bounded capabilities), consumed by Council,
  Arena, Collab, Chat. "Mode-specific routes must not build private integration systems."
- `bb55`'s brief (09-19) describes "sessions as the canonical work unit, Workforce for
  local workers, Tool Runtime for bounded capabilities, Collaboration Orchestrator
  above them, and the Archive Assistant remaining the read-only truth/control plane."

**INFERENCE:** the intended tree is layered — `main` (hub) → `9640` (runtime/identity)
→ `a9b7` (orchestrator + surfaces) → rooms (Waveyard, LUMA, …) — with `b544`'s seam
connecting the external AA. **Actual tree: flat siblings.** The briefs describe a
composite that exists on no branch. This is the **phantom-architecture problem**: each
new session inherits *briefs* that reference work that was never integrated, and treats
it as fact.

### 3.2 Concrete integration constraints (what any convergence must respect)

1. **Migration-number collisions.** `a9b7` defines `0009`–`0016` (studio_jobs … college);
   `9640` defines `0009`–`0026` (session_lifecycle … device_channel_hardening) — same
   numbers, different content. Merging both requires renumbering; mechanical, but real.
2. **`bb55` re-baselines history** (`0000_college_baseline.sql`): adopting the College
   means adopting its baseline convention (its own deployment doc prescribes exactly
   this for pre-runner databases).
3. **`bebf` re-homes the hub** into `apps/web` with `arena_*` namespacing and a
   `projects`-table name collision resolved by renaming Arena's — any Waveyard mount
   must keep those compatibility decisions (they are good ones).
4. **`b544` pins an external repo** (`SomeSafePortablesoftware@1a2200b`) and holds
   implementation on AA's Q1–Q4 answers. Its seam cannot "finish" from Arena's side.
5. **PR #1** is mergeable but its title/scope no longer match its branch.

---

## 4. The six questions, answered

**1. Which branch contains the actual current product?**
CURRENT FACT: the hub product that every record agrees on is `main` (`c1c1219`) —
19 working surfaces, verified independently by at least three later sessions. The
*current expression* of that product — with the rooms spine and honest service states —
is `arena-rooms-handoffs` (`1077e3a`), one additive commit over `main`, authored by
the owner personally. The deepest *integration* of the product plus new rooms is
`bebf` (`b690d99`).

**2. Which branches are experiments / gates / superseded slices?**
See §2 classifications. Summarised: `9640` = foundation capital (intended, never
landed); `a9b7` = surface layer (partially superseded); `b544` = governance capital
(deliberately read-only); `bb55` = a second product with best-in-repo production
discipline; `bdc9` = isolated surface; `bebf` = the deepest room integration. None is
garbage; none is the baseline on its own.

**3. What is the intended ancestry?**
Layered (§3.1): hub → tool runtime/identity → orchestrator/surfaces → rooms, with the
AA seam external. The actual ancestry is flat siblings off `c1c1219` — the intended
ancestry was never executed.

**4. What is the latest coherent integration point?**
Two, with different meanings: `bebf`/`b690d99` (deepest — hub + a real room + rooms/
handoffs machinery + tests + Docker + CI; Arena-side runtime gates open by its own
record) and `arena-rooms-handoffs`/`1077e3a` (latest, owner-authored, minimal, coherent
*as the product*, runs with the same requirements as `main`).

**5. What must be preserved?**
Everything, in place (§ Appendix B): all seven branches (each is the only home of its
slice), the recovery/compatibility decisions, the gate/lab records, the College
deployment discipline, the tool-runtime design, and `main`'s contract. The audit
recommends *tagging* for clarity, never deleting or rewriting.

**6. What is still genuinely blocking "just use Arena"?**
- For the hub baseline: **nothing structural.** Node 22 + `DATABASE_URL` (Postgres);
  the base's own agent doc records that the app still runs when the DB is down
  (persistence-dependent features aside); model features use local/BYOK paths.
- For the full `bebf` integration: the recovery audit's open gates (§2) — real-DB
  migration exercise of `arena_*` tables, cross-room handoff E2E, Compose topology
  extension — plus the heavy service topology for audio.
- For `b544`'s seam: blocked on AA (external Q1–Q4), by design.
- **The genuine blocker is process, not code:** 214 commits, seven parallel lines, zero
  merges, one stale PR, and briefs referencing a phantom composite. Every session pays
  a re-derivation tax, and the owner's laptop has no single obvious checkout.

---

## 5. Recommendation — one canonical baseline

### 5.1 The pick: `arena-rooms-handoffs` @ `1077e3a`

Rationale:

1. **It is the actual product.** The full verified hub contract, unmodified, plus the
   organizing spine (rooms + handoffs) that both the deepest session (`bebf`) and the
   owner converged on independently.
2. **It is the owner's own hand.** The only agent-free ref in the repository, and the
   newest tip — committed after reviewing the monorepo's rooms work, choosing the light
   baseline. Ratifying it is ratifying a decision the owner already made once.
3. **It is honest.** The rooms map says "No service connected" where that is true.
   It cannot mislead a future session into assuming Waveyard/Cut Lab/Congress exist.
4. **It runs anywhere `main` runs.** Zero dependency/schema/config changes; 1,131
   additive lines. Nothing to migrate, nothing to containerise, nothing to install
   beyond what the hub already needed.
5. **It changes no history.** `1077e3a` is a direct child of `c1c1219`: fast-forwarding
   `main` to it is lossless and rewrite-free, making `main` the single integration
   point again.

### 5.2 Roles for everything else

| Ref | Going-forward role |
|---|---|
| `arena/01a0bebf` | **The Waveyard room.** Preserved intact. Mount later (re-home onto the baseline per its own compatibility decisions, or link out) when its Arena-side gates close. Not the baseline — the audio topology (Redis/MinIO/worker/Demucs) must not gate daily hub use. |
| `arena/01a0bb55` | The College product + **portable discipline**: the 503-on-unsafe-auth health check and the migration-runner pattern should be folded into the baseline as small, deliberate commits. College itself mounts when its history adoption is decided. |
| `arena/01a0b544` | Merge `docs/` into the baseline as institutional memory (docs-only, no code). The personalisation seam waits on AA. |
| `arena/01a0a9b7` | Surface buffet: adopt per-surface, as rooms, when wanted (Studio/Cut Lab/Congress/Orchestrator each become a room-mount decision; classroom is superseded by the College). Close or retitle PR #1 rather than merging it wholesale. |
| `arena/01a09640` | Ratified design for the tool/identity layer. Adopt when a room actually needs tools (Waveyard's worker and the College's device tokens both point at it). |
| `arena/01a0bdc9` | LUMA: adopt as an isolated surface whenever; no conflict. |

### 5.3 The rule, applied (mirroring AA)

> **No more feature merry-go-round once the baseline crosses the usage threshold.**

- **Baseline:** `arena-rooms-handoffs` @ `1077e3a`, fast-forwarded into `main`.
- **Usage threshold (proposal):** the owner uses the baseline as the daily entry point
  on the laptop for 7 consecutive days, or completes 3 real tasks in it — whichever
  comes first.
- **After the threshold:** no new parallel session branches off `main` for features.
  New work mounts *on the baseline* as rooms, handoffs, or small PRs that actually
  merge. `main` stays the single integration point; the branch list may only grow for
  short-lived, merged-quickly work.
- **Before the threshold:** only bug fixes and the portable-discipline commits (§5.2)
  land on the baseline. No new surfaces until it is in daily use.

### 5.4 Laptop runbook (for the recommended baseline)

```bash
git clone https://github.com/imlochie/arena-os-canonical.git
cd arena-os-canonical
git checkout arena-rooms-handoffs        # or main, once fast-forwarded
npm install

# Local Postgres. The repo's drizzle.config.json hardcodes
# postgresql://postgres:postgres@127.0.0.1:5432/app_db — match it:
docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=app_db postgres:16

printf 'DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/app_db\n' > .env

npx drizzle-kit push    # applies the hub schema (dev tool; fine locally)
npm run dev             # http://localhost:3000 → "Browse the 12 rooms"
```

Model features follow the hub's existing local/BYOK paths; the rooms map states plainly
which services are not connected (Congress, Cut Lab, Waveyard) — believe it.

### 5.5 Alternative considered: `bebf` as baseline

If the owner's intent is that the *daily product* is hub + music room together, then
`bebf` @ `b690d99` is the only coherent integration that exists — but it should be
chosen with eyes open: its own recovery audit lists open Arena-side runtime gates, its
runtime topology is heavy for daily hub use, and the owner's very next commit after its
tip distilled the rooms concept onto the light baseline instead. **OWNER DECISION
REQUIRED** (this audit recommends the light baseline and mounting Waveyard second).

---

## 6. Proposed next moves (all owner-ratified, in order)

1. **Ratify the baseline** (`arena-rooms-handoffs` @ `1077e3a`, or `bebf` — §5.5).
2. **Fast-forward `main`** to the ratified baseline (lossless; `1077e3a` is a direct
   child of `c1c1219`). `main` becomes the single integration point again.
3. **Tag the slices** for role clarity (suggested: `slice/tool-runtime`,
   `slice/surfaces`, `slice/gates-aa-seam`, `slice/college`, `slice/luma`,
   `room/waveyard`, `baseline-pre-convergence`) — tags only; no deletions, no rewrites.
4. **Decide PR #1:** retitle to reflect full scope, or close it in favour of
   per-surface room mounts (recommended).
5. **Fold in the portable discipline** (health-check 503 rule, migration runner) as two
   small, deliberate commits on the baseline.
6. **Get the baseline onto the laptop** (§5.4) and start the usage-threshold clock.
7. **Mount Waveyard as the first real room** once its Arena-side gates close — this is
   the next beast after the baseline is stable.

---

---

## 7. Owner ratification and close-out (append-only; 2026-10-05)

Recorded the same session the audit was produced, from the owner's explicit
selections:

| Decision | Ratified |
|---|---|
| **Canonical Arena baseline** | `arena-rooms-handoffs` @ `1077e3a` — the hub plus the owner's rooms map and draft handoff ledger. This is the tree that goes on the laptop. |
| **`main` fast-forward** | **DEFERRED.** The baseline runs from its branch on the laptop first; `main` is fast-forwarded only once the usage threshold has actually been crossed. `main` stays pinned at `c1c1219` until then. |
| **Usage-threshold clock** | Starts when the baseline is running on the laptop. Threshold per §5.3: 7 consecutive days of daily use, or 3 real tasks completed — whichever comes first. |
| **Merry-go-round rule** | In force from ratification: no new parallel session branches off `main` for features; new work mounts on the baseline (rooms, handoffs, small merged PRs) or waits. |

Adjusted next moves, in order:

1. ~~Ratify the baseline~~ — **done** (this section).
2. **Get the baseline onto the laptop** (§5.4 runbook; checkout `arena-rooms-handoffs`).
3. Start the usage-threshold clock.
4. When the threshold is crossed, fast-forward `main` from the laptop — the exact
   command, lossless by construction:

   ```bash
   git checkout main && git merge --ff-only arena-rooms-handoffs && git push origin main
   ```

5. Then the §6 order stands: tag the slices, settle PR #1, fold in the portable
   discipline (503 health rule, migration runner), and mount Waveyard as the first
   real room once its recovery gates close.

**No branch was deleted, rebased, or rewritten. The only refs changed by this audit
session are its own record branch (`arena/01a10c30-arena-os-canonical`, this document).**

---

## 8. Erratum and runtime verification (append-only; 2026-10-06)

### E1 — Baseline defect: undeclared `lucide-react` dependency

Found by doing exactly what §5.4 prescribed on a clean machine: `npm ci` then
`npm run build` **fails**. The baseline commit `1077e3a` adds
`ArenaRoomsDirectory`, `ArenaRoomDetail`, and `ArenaHandoffsLedger`, all of which
import `lucide-react` — but `package.json` (unchanged from `main`, which never used
the module) does not declare it, and no lockfile entry exists. The baseline only ever
ran on machines that already had `lucide-react` in `node_modules` from other work.

- **Fix:** `e3ef522` on this session branch (`fix: declare the missing lucide-react
  dependency…`). After it, a clean install builds and runs.
- **Consequence for §7:** when the usage threshold is crossed, `main` must **not**
  fast-forward `arena-rooms-handoffs` alone — that would carry the defect. Fast-forward
  to a ref that includes the fix: merge this session branch
  (`arena/01a10c30-arena-os-canonical`, which is baseline + fix + this record). The
  §7 ff-only command is amended to:

  ```bash
  git checkout main && git merge --ff-only arena/01a10c30-arena-os-canonical && git push origin main
  ```

  (valid because this session branch now contains `1077e3a` as an ancestor).
- The §5.4 runbook is otherwise unchanged and now works as written on a fresh machine.

### R1 — Runtime verification record (2026-10-06, clean install)

Environment: Node 22.22.3 · PostgreSQL 17.10 (unprivileged, loopback) · production
build, all from a clean `npm ci` after `e3ef522`:

| Check | Result |
|---|---|
| `npm run build` | ✅ 22 routes compiled (static + dynamic) |
| Pages (`/`, `/rooms`, `/rooms/[roomId]`, `/handoffs`, `/command`, `/council`, `/chat`, `/projects`, `/artifacts`, `/privacy`, `/guide`, …) | ✅ all 200 |
| Rooms directory honesty | ✅ renders "Existing app surface" / "No service connected" / "Approval required" states; the Waveyard room states "Audio services are not connected. No audio is generated or processed." |
| `GET /api/health` | ✅ `{"ok":true}` (real DB round-trip) |
| `GET /api/models` | ✅ model registry populated (local + free-provider paths) |
| `GET /api/stats` | ✅ live stats (Bradley–Terry board at seed ELO 1200) |
| Write path: `POST /api/projects` → list → `POST /api/projects/[id]/memory` | ✅ 201 + persisted + retrieved |
| `POST /api/chat` (default model, no keys) | ✅ responds in hub local mode ("local mode — no internet used") — the $0-local-first path by design; provider quality needs BYOK/free-provider egress |
| Database | ✅ `drizzle-kit push` clean; 18 tables in `app_db` |

The baseline's open items from here are only what §2 always said: provider egress for
non-local model quality, and the other rooms' services (Waveyard topology, Congress,
Cut Lab) — which the rooms map already states honestly.

### R2 — Sandbox runtime note (for restarting this preview after a sandbox rebuild)

PostgreSQL runs unprivileged from npm-packaged binaries (apt is blocked in this
sandbox); the data dir persists at `/home/user/pgdata`:

```bash
# one-time per sandbox: fetch binaries and create missing soname symlinks
mkdir -p /tmp/pgdist && cd /tmp/pgdist && \
  npm pack @embedded-postgres/linux-x64@17.10.0-beta.17 --silent && \
  tar xzf embedded-postgres-linux-x64-*.tgz && rm *.tgz && \
  cd package/native/lib && for f in *.so.*; do case "$f" in *.a) ;; \
    *) b=$(echo "$f" | sed -E 's/^(.*\.so\.[0-9]+).*/\1/'); \
       [ "$b" != "$f" ] && [ ! -e "$b" ] && ln -s "$f" "$b";; esac; done

# if /home/user/pgdata is missing: initdb first (scram, user postgres, password postgres)
# then, as two background processes:
LD_LIBRARY_PATH=/tmp/pgdist/package/native/lib \
  /tmp/pgdist/package/native/bin/postgres -D /home/user/pgdata \
  -c listen_addresses=127.0.0.1 -p 5432
cd /home/user/arena-os-canonical && npm start -- -H 0.0.0.0 -p 3000
```

`.env` (gitignored) holds
`DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/app_db`.

---

## 9. Rooms runtime status (append-only; 2026-10-06, second session)

Owner question: *"Is Waveyard still functioning alongside Arena? I never got to test
it since it was stuck behind a fake sign-up page. How far along is LUMA / the other
rooms?"* This section records what was actually run, not what is claimed.

### W1 — Waveyard is running alongside Arena (verified live)

The `bebf` monorepo (`b690d99`) was stood up from scratch in the sandbox as a second
live preview (web on :3001; the ratified baseline hub remains on :3000):

| Piece | Status |
|---|---|
| PostgreSQL 17.10 | ✅ running (npm-packaged binaries, unprivileged) |
| Redis 7.4.1 | ✅ compiled from source (all binary hosts blocked; gcc was available) |
| Storage | ✅ `STORAGE_PROVIDER=local` — the monorepo ships a filesystem driver; no MinIO needed |
| Migrations | ✅ all 19 applied; **52 tables**: `arena_*` namespaced hub + full Waveyard domain + `arena_room_handoffs` |
| Web (production build) | ✅ Next 16.3.5, `/waveyard/*` + Arena hub + rooms + handoffs all 200 |
| Worker | ✅ **doctor 9/9 PASS** (ffmpeg, python, storage, redis, postgres, numpy, analysis, torch, demucs) |

### W2 — The "fake sign-up page" was never fake: root cause found and fixed

The Waveyard auth form (on `/waveyard`, component `AuthForm`) is a **real**
implementation: zod-validated registration, `node:crypto` password hashing, DB insert
with unique-constraint handling (23505 → "already registered"), and an immediate
session cookie — no email verification gate.

Reproduced live this session: when the web server runs **without `DATABASE_URL`**, the
page renders perfectly but every registration returns a generic
`{"error":"Account could not be created."}` (500). Server log, verbatim:
`registration failed Error: DATABASE_URL is required to access Waveyard data.`
**That is the "fake sign-up page": a real form against an unconfigured stack.** With
env set, the same form registered a real account (201, user persisted, session works).

### W3 — End-to-end pipeline results (real evidence)

| Step | Result |
|---|---|
| Register → session | ✅ 201, cookie, persisted |
| Create project | ✅ (field is `title`, not `name`) |
| Upload 30s WAV | ✅ server-validated (ffprobe metadata, sha256 checksum, size limit), stored via local provider, separation + waveform jobs queued transactionally |
| Waveform job | ✅ **complete** (ffmpeg) — the Studio player has a real source waveform |
| Separation job | ❌ **fails honestly**: `separation_failed` — htdemucs weights unreachable from this sandbox |
| Stems | 0 (never invented — by design) |

**Model weights note:** `htdemucs` (`955717e8-8726e21a.th`, 80MB) is hosted only on
`dl.fbaipublicfiles.com`, which this sandbox blocks (as are HuggingFace, jsdelivr, raw
GitHub, GitHub release assets, Docker registries, Anaconda). Every reachable channel
(PyPI, npm, GitHub git/codeload + API search, source compilation of Redis) was used
where possible; no package or repo vendors the checkpoint. **On the owner's laptop the
first separation simply downloads the model (~80MB, one time)** — the README's
documented behavior. The failure here is environmental, not a Waveyard defect, and the
system treated it exactly as its doctrine requires.

**Deployment addendum (learned live):** `packages/audio` requires **both `ffmpeg` and
`ffprobe` on PATH** (uploads fail with "could not be decoded as supported audio"
without ffprobe). In this sandbox: ffmpeg via PyPI `imageio-ffmpeg`, ffprobe via PyPI
`ffprobe-binaries-only`. The Docker Compose stack provides both already.

### W4 — LUMA status (`bdc9` @ `c6b4527`)

Standalone Expo/React Native/TypeScript camera-first photography app, 84 files:
5 tab screens (camera/create/edit/settings + index), editor, licenses, privacy pages;
52 `src/` files (CameraSelector, PhotoRenderer, PresetCarousel, LayerView, …);
**14 test/spec files with jest configured**; 6 docs. Commit trail: V1 camera app →
Camera V2 (swipeable cameras) + Cameras/Looks reframe → deterministic adaptive look
resolver → thumbnail-analysis-driven adaptive export → device readiness fixes →
explicit Arena/media boundary ("Independent by design. No Arena account is required").
**Integration with Arena: none beyond the hub's `/luma` page, which links out to it.**
Not runnable in this sandbox (needs a device/simulator); untested on-device here.
Verdict: a self-contained, structured, test-configured mobile app at roughly
"V1 + Camera V2 + looks" maturity; mounting it into Arena is a future decision, not
existing wiring.

### W5 — Other rooms, one line each (as of this session)

| Room (rooms-map state) | Reality |
|---|---|
| Assistant / Orchestrator / Council / Spaces / Archive Assistant / Classroom(→guide) / Studio(→collab) / LUMA(→image) / Device Security(→privacy) | `available` — existing hub surfaces in the baseline (:3000), all 200 |
| Waveyard | **NOW RUNNING** on :3001 (monorepo): auth, projects, validated upload, waveforms real; separation pending reachable model download (laptop-fine) |
| Congress, Cut Lab | `local` — code exists only on `a9b7` (unmounted slice; see §2) |
| Studio (full multimodal) | `a9b7` code; the baseline's rooms map deliberately points Studio at existing `/collab` instead |
| Classroom (real tutor runtime) | superseded by the College (`bb55`), a separate product concept (§2) |
| Archive Assistant (AI seam) | `b544` — blocked on external AA Q1–Q4 by design (§2) |

### W7 — Rooms-map honesty fix (2026-10-06, third session)

Owner finding by usage: rooms marked open led to semantically wrong surfaces —
Classroom ("Learn") → `/guide` (app documentation), LUMA ("See") → `/image` (AI
text-to-image generation), Studio ("Make") → `/collab` (iterative multi-model work).
The map was honest about *service states* but dishonest about *name–surface fit*.

Rule applied (same doctrine as the rooms map itself): **a room may only be "open"
if the surface behind it is what the room's name promises.** Changes:

- Classroom, Studio, LUMA: `available` → `local`; destinations removed; descriptions
  now say what is missing, where the real thing lives (unmounted branch), and that
  the similarly-named surface is a *different thing*. The real services: teaching
  runtime = the College (`bb55`), multimodal Studio (`a9b7`), LUMA camera app (`bdc9`).
- Archive Assistant → renamed **"Archive"** (id unchanged, so existing handoffs keep
  referencing it): the surface is the artifacts browser; the name no longer promises
  an assistant the room does not have.
- No surface lost: Guide, Collab, and Image remain in the top nav as themselves.
- Six rooms open (Assistant, Orchestrator, Council, Spaces, Archive, Device
  Security), six honestly closed (Congress, Classroom, Studio, Cut Lab, Waveyard,
  LUMA).
- Not applied to the `bebf` monorepo's own rooms copy (preserved slice): when
  Waveyard mounts onto the baseline it inherits the corrected map.
  *(W7's Archive rename is superseded by W8 below: the room is the AA bridge.)*

### W6 — Related discovery

`imlochie/arena-os-local-first` (261KB, last updated 2026-09-12 — one day before
`arena-os-canonical`'s initial commit, no description): a pre-canonical experiment.
Flagged for a future audit pass; does not affect the baseline decision (§7).

### W8 — The Archive Assistant room is a real bridge (2026-10-06, fourth session)

Owner correction: *"Archive Assistant is supposed to be a real connection to my other
app."* The W7 rename to "Archive" (artifacts browser) flattened the room's meaning.
Investigation and remount, all verified live:

**What the connection actually is** (`b544`, docs/archive-assistant-integration.md):
a server-only, read-only client to the Archive Assistant app
(`imlochie/SomeSafePortablesoftware`) over a six-operation GET contract —
overview, workload, reconciliation summary, finding lineage, provider refresh
state + history — validated against an auto-generated OpenAPI snapshot, feeding
`GET /api/archive/context`. Arena can never approve, reject, execute, move, or
sync anything in AA. 55/55 seam tests pass on the baseline after mounting.

**Provenance discovered live:** the contract's true source is the AA **branch**
`arena/01a0a0d9-somesafeportablesoftware` (per the generated contract header) —
NOT AA main. AA's main tip serves none of the `/assistant/*` routes, and the
personalisation endpoints pinned at `1a2200b` are also absent from main's tip.
Both Arena-side seams therefore pin AA states that main-tip AA no longer carries;
the arena bridge branch is where the six-operation API lives. (AA main's PG layer
is an empty scaffold; its real data plane is SQLite via `node:sqlite`.)

**Mounted on the baseline this session:**

- `src/lib/archive-assistant/*` (15 files: client, config, context, contract,
  validator, errors, fixtures, prompt + tests), `src/lib/contract-validation.ts`,
  `src/app/api/archive/*` (context + finding-lineage routes + route tests),
  smoke/mock scripts + node test loader, `npm test` / `npm run smoke:archive`.
- New `bridge-status.ts` server probe + `ArchiveAssistantBridge` panel: the room
  page shows the REAL state — unconfigured / bearer-configured / unreachable /
  auth-required / contract-mismatch / connected with live facts.
- Room entry: name restored to **Archive Assistant**, eyebrow "Bridge", open,
  no substitute destination — the room page itself is the surface.

**Live verification (sandbox):** AA booted from the arena bridge branch
(`AUTH_MODE=local`, `node:sqlite`, port 8080); Arena configured with
`ARCHIVE_ASSISTANT_API_URL=http://127.0.0.1:8080/api`,
`ARCHIVE_ASSISTANT_AUTH_MODE=local`, `ARCHIVE_ASSISTANT_OWNER_ID=__local__`.
The room renders **Connected to Archive Assistant** with real overview facts;
`/api/archive/context` returns the full bounded context from the real app.
Failure paths fail closed (covered by the 55-test suite).

**Not mounted (deliberately):** the Gate-7 reasoning lattice and the Gate-8
personalisation seam remain on `b544` — the first is the interpretation layer
(chat integration), the second is held pending AA-side surfaces per the ratified
lab-004 record. Mounting the bridge was the owner-stated minimum for this room.

**Also this session:** `origin/main` was found moved to `e2d280a` (owner
fast-forward after the Waveyard turn). The session branch remains a descendant;
the amended §8 ff command still applies and now carries the README, rooms-honesty
fixes, and this bridge mount.

### W9 — Rooms become usable content, zero AI configuration (2026-10-06, fifth session)

Owner direction: *"integrate the rooms background work into actual usable content;
I shouldn't have to configure any AI either."* Mounted the AI-driven room surfaces
from `a9b7` onto the baseline (selective mount, not merge — a9b7 predates the rooms
work and would have deleted it):

| Room | What is now real | Verification (sandbox, live) |
|---|---|---|
| **Congress** | `/congress` — timed multi-seat deliberation, durable resumable turns | session created, proposer/skeptic/chair spoke in local mode ("no internet used"), turns persisted |
| **Classroom** | `/classroom` — the executable teaching loop over the real Lochie Life College content (semester resolved by date, memory, checkpoints) | class started `localOnly`, College state machine resolved today's occurrence |
| **Orchestrator** | `/orchestrator` — multi-participant collaboration bus: relays, perspectives, best-interest deliberation, tool-capable participants | collaboration created with 2 participants; deliberation round run |
| **Spaces** | `/spaces` — recurring agent workbench with money-work templates | space created, run executed in local mode, recurring tick endpoint live |

Zero AI configuration: every room calls the same `generate()` seam, which defaults
to the offline local engine (deterministic, zero egress) — verified with NO provider
keys in the environment. Quality upgrade paths stay optional and documented
(browser on-device WebLLM via Arcade, BYOK free-tier/providers, or a local
TurboAgent server — ai.ts now supports all three, ported from a9b7).

Mount details: libs (congress, congressRoles, orchestrator, spaces, spaceTemplates,
classroom, college, preferences, assistantTools, archive, ai.ts, models.ts),
components, pages, API routes; schema.ts extended with exactly the mounted rooms'
tables (studioJobs/cutProjects deliberately trimmed — Studio/Cut Lab remain honestly
closed pending their engines); migrations renumbered 0009–0014 (congress, spaces,
collaborations, preferences, college, archive) following baseline 0008.

Rooms map after this session: **9 open** (Assistant, Orchestrator, Council,
Congress, Spaces, Classroom, Archive Assistant bridge, LUMA→closed see W7,
Device Security) — precisely: open = Assistant, Orchestrator, Council, Congress,
Spaces, Classroom, Archive Assistant, Device Security; closed = Studio, Cut Lab,
Waveyard (branch `bebf`), LUMA (branch `bdc9`). Nav extended with the four new
rooms.


---

## Appendix A — verification log (commands and key outputs)

- `git ls-remote --heads origin` — tips match §1 table exactly.
- `git fetch origin 'refs/heads/*:refs/remotes/origin/*' --prune` — all refs fetched.
- Merge-base matrix over all 28 branch pairs — **every pair resolves to `c1c1219`**.
- `git rev-list --count origin/main..origin/<b>` — 16/12/51/23/10/101/1.
- `git log origin/main..origin/<b> --format='%B' | grep -c 'Co-authored-by: arena-agent'`
  — 16/12/51/23/10/65/**0**.
- `git log -1 origin/arena-rooms-handoffs^` — parent is `c1c1219` (direct child of main).
- `git diff --name-status origin/main origin/arena-rooms-handoffs` — 10 files, all `src/`,
  1,131 insertions, no dependency/schema/config changes.
- Hub-fidelity sweep `main:src` → `bebf:apps/web/src` — 32 SAME / 31 DIFFERS / 37 ABSENT
  (relocated to `packages/*`).
- `gh pr list --state all` — exactly one PR (#1); `gh pr view 1` — OPEN, MERGEABLE,
  head `e60e359`, created 2026-09-16T10:49:22Z.
- `git tag` — empty; `gh release list` — empty.
- Docs read at their tips: `bebf:docs/RECOVERY_AUDIT.md`, `RECONNAISSANCE.md`, `README.md`;
  `bb55:docs/college-runtime-architecture.md` §0, `docs/deployment.md`, tip commit
  message; `b544:docs/gate-8-arena-tree-first-discovery.md`, `lab-004-decision-record.md`;
  `a9b7:AGENTS.md`; `9640:docs/tool-runtime-architecture.md`; `arena-rooms-handoffs`
  full diff incl. `src/lib/arenaRooms.ts`, `src/lib/arenaHandoffs.ts`.

## Appendix B — preservation register

| Asset | Home (ref @ tip) | Preservation mode |
|---|---|---|
| Verified hub contract | `main @ c1c1219` | Immutable history; subsumed by baseline |
| Rooms map + draft handoffs | `arena-rooms-handoffs @ 1077e3a` | The baseline |
| Waveyard room + recovery decisions + Compose/CI/E2E | `arena/01a0bebf @ b690d99` | Keep branch intact; tag `room/waveyard`; mount second |
| College runtime + deployment/health discipline | `arena/01a0bb55 @ 5fcb4d7` | Keep branch; tag; port the 503 rule + migration runner to baseline |
| Gates/labs/decision records + AA seam | `arena/01a0b544 @ 53b5ca0` | Keep branch; merge `docs/` to baseline (docs-only); seam waits on AA |
| Studio/Cut/Congress/Spaces/Orchestrator/TurboAgent surfaces | `arena/01a0a9b7 @ e60e359` | Keep branch; adopt per-surface as rooms; settle PR #1 |
| Tool runtime + owner/device identity design & code | `arena/01a09640 @ c8e5eb6` | Keep branch; ratified design for the tools layer |
| LUMA camera app | `arena/01a0bdc9 @ c6b4527` | Keep branch; isolated; adopt whenever wanted |

**No branch is deleted, rebased, or rewritten by this audit. Everything is preserved;
the only change proposed is *which one we call the product*.**

---

## W10 — AI Runtime three-tier refactor (2026-10-06)

**The dishonesty removed:** the model list presented Forge-branded names (GPT,
Mistral, DeepSeek, …) as *local* models, all secretly served by the deterministic
offline engine. Every tier now says what it is.

**The contract (src/lib/runtime.ts):**
- Tiers: `local-engine` (deterministic, NOT an LLM, zero config, always ready) ·
  `local-llm` (WebLLM in-browser via WebGPU; TurboAgent local server) ·
  `remote-free` (Pollinations keyless; OpenRouter/Groq BYOK; network required).
- `generate()` returns what ACTUALLY executed:
  `{text, runtimeTier, backend, modelId, via, ms, fallback, fallbackFrom?, note?}`.
- Fallbacks append a visible `⚠️ **Fallback: Local Engine**` notice naming the
  requested model and the failure reason — never invisible, never rebranded.
- Battles between two Local-Engine-backed selections → HTTP 409 `{sameEngine:true}`;
  fallback-induced sameness post-execution → `sameEngine:true` + notice in the payload.
- `battleSetup` resolves legacy aliases (`offline-sage` → `local-engine`) and no
  longer silently re-rolls same-engine picks into a random cloud pair.

**UI:** tiered `RuntimeSelector` (chat), tiered `FighterSelect` groups (battles),
`ActiveRuntime` badge on every chat reply (from returned metadata, not selection),
`/runtime` config page (WebGPU status, WebLLM download/cache, TurboAgent URL test,
Pollinations reachability test, BYOK keys). Nav gains ⚙️ Runtime.

**Browser WebLLM:** DirectChat executes `__webllm__` models in-browser (WebGPU) and
the server persists exactly what ran (`clientReply` marked `via webllm`,
note "executed in your browser"); server-side WebLLM requests return the honest
browser-only fallback. TurboAgent URL travels via `loadKeys().turboagent`.

**Verified live (sandbox, network-blocked):** Tier 1 executed directly (0 ms, no
fallback); Tier 2 executed honestly as labelled fallbacks (WebLLM browser-only;
TurboAgent not configured); Tier 3 attempted real network calls, failed (egress
blocked), and fell back visibly with the reason. All three 409 same-engine guards
fire; mixed-tier battles run with per-side runtime metadata. On a networked
machine the remote tier answers for real — same code path, no changes needed.

**Tests:** 12 new contract tests in `src/lib/runtime.test.ts`; suite 67/67
(55 baseline + 12); typecheck clean; production build clean.

---

## Part B completion — rooms made real (2026-10-06)

Ported from the unmounted canonical branches (selective ports, no merges) into
`src/lib/*`, `src/components/*`, `src/app/*`. The rooms directory now marks a
room AVAILABLE only when its primary workflow actually runs.

### Studio (media generation) — `/studio`
Procedural demo backend always works offline (image/audio/video synthesis →
real SVG/WAV/MP4 artifacts served from the job store); WanGP / ComfyUI /
DashScope report live online status and are honestly offline when not running.

### Cut Lab (video editing) — `/cut`
Browser-native editor: real timeline with clips, procedural clip generation,
`MediaRecorder` export to a downloadable video file; projects persist via
`/api/cut` (POST/GET/DELETE verified live).

### Waveyard (music) — `/waveyard`
Project → audio source upload (multipart; browser-side `decodeAudioData` +
real min/max peak buckets) → on-disk bytes under `.data/waveyard/` →
`/api/waveyard/sources/{id}/audio` round-trip → arrangement versions with
clip sourceId validation (invalid → 400). Cascade delete verified. Stem
separation / tempo / key detection require the Waveyard worker and are shown
as honestly unavailable — no fake fallbacks.

### LUMA (photography) — `/luma`
The real LUMA engine port: adjustments / color pipeline (4×5 color matrix) /
adaptive presets / history / layers / camera catalog — pure math, identical
recipes to the native app. Web backend is `CanvasProcessingEngine` (same
`ProcessingEngine` interface); projects persist to localStorage. **Photography
of YOUR images — no text-to-image.** The original 86-test LUMA suite now runs
in this repo (node:test + a small jest-compat expect shim) — suite 162/162.

### Device Security — `/device-security`
Browser-observable checks only (secure context, transport, WebCrypto, WebGPU,
storage quota, permissions, JS heap) with explicit "not observable from the
browser" for OS/AV/firewall claims. Separate from Privacy controls, linked.

### Live E2E matrix (sandbox, egress blocked — honest results)
- Pages: 26/26 → 200 (`/`, `/rooms`, `/luma`, `/waveyard`, `/studio`, `/cut`,
  `/device-security`, `/benchmark`, `/council`, `/congress`, `/collab`,
  `/orchestrator`, `/classroom`, `/spaces`, `/chat`, `/image`, `/privacy`,
  `/runtime`, `/command`, `/projects`, `/artifacts`, `/arcade`, `/guide`,
  `/handoffs`, `/leaderboard`, `/assistants`).
- Rooms directory: studio / cut-lab / waveyard / luma / device-security all
  render AVAILABLE with working destinations.
- Assistant chat: Local Engine reply with honest runtime metadata
  (`via: offline-fallback`, `fallbackFrom: pollinations/openai`, reason).
- Battles: `local-engine` vs `local-engine` → 409 `sameEngine:true`;
  fallback battles persist real `runtimeA`/`runtimeB` (backend, via, reason).
- Studio: demo job full lifecycle running → completed, media fetchable
  (200, image/svg+xml); `/api/studio/health` shows wangp/comfyui offline.
- Waveyard: create → upload (peaks stored) → audio bytes round-trip →
  version save → invalid clip 400 → cascade delete.
- Cut Lab: POST/GET/DELETE project round-trip.
- Archive Assistant: honest `archive_assistant_not_configured` (GET-only
  bridge preserved, no localhost fallback).
- Gates: `tsc --noEmit` clean · `npm test` 162/162 · `npm run build` clean ·
  `db:setup` applied.

---

## Rooms directory routing fix (2026-10-06, follow-up to ad86c3b)

**Bug:** room cards in `ArenaRoomsDirectory` linked every room to the generic
detail shim `/rooms/{id}` instead of its real working surface, and the
Archive Assistant room had no `destination` at all — the directory showed it
as "Address only" even though its live bridge page is its working surface.
The surfaces themselves (/studio, /cut, /waveyard, /luma, /device-security)
were fine; the navigation layer in front of them was not.

**Fix:**
- Cards now link directly to `room.destination.href` (fallback to the detail
  page only for rooms with no destination — none today).
- Archive Assistant gets an explicit destination:
  `/rooms/archive-assistant` ("Open live bridge") — the [roomId] page is where
  the server-side connection probe resolves and the bridge renders; it is the
  room's real surface, not an address-only entry.
- All 12 rooms now have destinations; zero "Address only" cards.

**Regression guard** — `src/lib/arenaRooms.test.ts` (5 tests): fixed 12-room
inventory; every available room must have a destination; the exact href
matrix; **every destination href must resolve to a real `page.tsx` route under
`src/app`** (filesystem scan with dynamic-segment matching) — this fails the
suite if any card ever points at a route no page serves.

**Live 12-room navigation matrix (all pass):**
assistant → /assistants · orchestrator → /command · council → /council ·
congress → /congress · spaces → /spaces · archive-assistant →
/rooms/archive-assistant · classroom → /classroom · studio → /studio ·
cut-lab → /cut · waveyard → /waveyard · luma → /luma · device-security →
/device-security — 12/12 hrefs correct, 12/12 HTTP 200, real UI content
confirmed on every surface, secondary destinations (/chat, /projects,
/privacy) 200, bridge page shows the honest unconfigured state, and a
Waveyard create → upload → fetch → delete round-trip passes on the live
database.

Gates: tsc clean · 167/167 tests · production build clean.

---

## Waveyard: full studio port (2026-10-06, replaces the thin first pass)

The first Waveyard mount was a ~900-line sketch (project/upload/4-track
timeline). It has been **replaced by the real Waveyard implementation**, ported
selectively from the original Waveyard project on branch
`arena/01a0bebf-arena-os-canonical` (monorepo: apps/web + apps/worker +
packages/* + services/*). No branch merges; every file was ported and adapted.

### Ported (verbatim unless noted)
- **Domain package** `@waveyard/types` (19 modules, ~2,100 lines): musical key,
  beat grids, clip construction/editing, source sections, section arrangement,
  cross-source alignment, arrangement automation + extensions, musical events,
  drum/harmony/vocal analysis, MIDI, meeting points, multi-source placement,
  automatic remix, source acquisition, visual state. → `src/lib/waveyard/types/`
- **24 original domain unit tests** now run in the repo suite (node:test +
  jest-compat shim extended with toMatchObject/objectContaining/any).
- **Schema**: 29 tables ported to `src/db/waveyardSchema.ts` (source/stem/
  waveform assets + jobs, five analysis families, remix sessions/tracks/clips/
  automation/versions, exports, builds, acquisitions, audit events). `projects`
  is table `wy_projects`; users/sessions/project_members dropped (Arena is a
  local-first single-owner app — actor columns record LOCAL_OWNER_ID).
  drizzle.config points at both schema files. The Waveyard→Arena bridge table
  `arena_room_handoffs` (migration 0019) is ported into `src/db/schema.ts`.
- **45 API routes** — uploads (multipart + honest client-probe fallback),
  assets (range streaming + waveform delivery), remixes (state/tracks/versions/
  restore/meeting-points/placements/automation/extensions/clips:
  edit/batch/from-section/loop/slice/align-beat), remix-versions/exports,
  sources (events/harmony), stems (drum/vocal), analyses retries,
  waveform-jobs, jobs, publication, moderation, public catalogue, and the
  arena-handoff bridge (creates a real Arena project + artifact + handoff row).
- **Studio UI** (33 components, ~4,600 lines): StudioCore (733), 20 studio
  panels (timeline, transport, stem mixer, clip inspector, section maps,
  analysis summaries, meeting points, version history…), ProjectWorkspace,
  BuildProject, LivingPlayer + player-state, CinematicVisual,
  AutomaticRemixPrompt, WaveformCanvas, DiscoverCatalog, ModeratorReview,
  PublicProject, PublicationPanel, WaveyardHandoffPanel. →
  `src/components/waveyard/`. Original stylesheets ported to
  `src/app/waveyard/waveyard.css` (route-scoped, no class collisions).
- **Six pages**: /waveyard (home + intake), /create, /discover, /moderation,
  /p/[id] (public release), /projects/[id] (workspace → StudioCore).
- **Worker subsystem preserved** at `waveyard-worker/` (runnable where
  Redis/ffmpeg/Python exist): apps/worker (15 BullMQ modules + doctor),
  services (separation/analysis python), packages (types/queue/storage/
  database/audio), original vitest tests, README. NOT part of the web build
  (excluded from root tsconfig; own workspace).

### Honest-offline adaptations (each labeled, none fake)
- **Queue**: web-app enqueue is real when REDIS_URL + bullmq exist; otherwise
  it throws and jobs persist as `failed / queue_unavailable` with the reason —
  surfaced in the UI, retryable. Never a fake progress state.
- **Client-probe fallback**: when the server has no ffprobe, the browser's
  Web Audio decode (real duration/sampleRate/channels) may stand in; recorded
  as `probeSource: "client-webaudio"` in the acquisition metadata.
- **Browser-computed waveforms**: real `waveyard-peaks-v1` peaks (44.1 kHz
  mono canonical format) computed in-browser, validated by the same
  `validateWaveform()` as worker output, stored with job stage
  `browser-computed`.
- **Unseparated-source bridge**: arrangement tracks bind to stems; without
  separation the user can explicitly add the full, unseparated source as a
  track — stem row `engine: passthrough-unseparated`, `stemType: "source"`,
  linked to the failed separation job. The automatic-remix engine then builds
  its honest no-analysis fallback ("preserved the source as one continuous
  arrangement").
- Publication requires a completed worker export before a project can go
  public — unchanged from the original; nothing publishes unrendered audio.
- Meeting-point discovery requires verified structural analysis — honest 4xx
  offline, unchanged.

### Live E2E (sandbox: no redis, no ffmpeg, no worker — all results honest)
project create → build record → upload (client-probe, 503 queue-unavailable
with source+waveformJobId) → browser waveform stored+served at all 5
resolutions → passthrough stem streams source bytes (200, 60000 B) →
automatic remix builds session + "track.mp3 — Source" track + full-length clip
→ clip edit PUT (vol 0.7, dur 2000 ms) → versions save/list → arena handoff
creates Arena project + artifact + handoff row → export honestly 503 →
publication honestly requires a completed export → jobs show
failed/queue_unavailable → public/moderation/discover/home pages 200 →
12-room navigation matrix still 12/12.

### Gates
`tsc --noEmit` clean (root; waveyard-worker has its own workspace tsconfig) ·
`npm test` **218/218** (167 prior + 51 waveyard domain tests) · production
build clean (22 pages) · `db:setup` applied (29 new tables) · E2E data
cleaned up afterwards.

---

## Arcade game forge + Spaces agent fleets (2026-10-06)

**Arcade** — the forge's template library gained two real engines:
- **Falling Blocks (Tetris)**: complete single-file implementation — 7 pieces
  × 4 rotations with wall kicks, 7-bag randomizer, hold, ghost piece, hard
  drop, next queue, line-clear scoring (100/300/500/800 × level), levels,
  persistent high score, touch controls. Parameterized: board size, start
  level, gravity curve, hold/ghost toggles, theme.
- **Merge Numbers (2048)**: full merge logic, win-with-continue, dead-end
  detection, grid size as a real difficulty axis (3×3 brutal / 4×4 classic /
  5×5 roomy), target tile configurable.
Prompt routing recognizes both ("tetris", "falling blocks", "2048",
"merge numbers", …); mods (turbo/hard/easy/theme) produce labeled remixes.
6 new contract tests (src/lib/games/forge.test.ts): routing, validator pass,
required subsystems, mods-change-output, and a parse-only JS syntax gate on
the emitted code. Live: "tetris but turbo and hard mode" → 13.8KB playable
remix, persisted; "2048 hard mode" → 3×3 grid.

**Spaces** — from a single-model cron loop to a real multi-agent work
environment:
- New `space_agents` table (name, role, modelId, systemPrompt per agent) and
  per-agent attribution on `space_runs` (agent_id, agent_name).
- `runFleet` executes every agent **concurrently** against the same standing
  task (each with its own runtime — Local Engine offline, or any configured
  model), persists each contribution with its own honest runtime metadata,
  then synthesizes one deliverable (same fallback chain as everything else).
- API: /api/spaces/[id]/agents (list/add), /agents/[agentId] (delete),
  /fleet (run now). UI: AgentFleet panel inside every space window — staff
  the fleet, run it, see per-agent outputs with runtime badges + synthesis.
- The role brief leads each agent's message so even the deterministic Local
  Engine produces genuinely different, role-shaped contributions (verified:
  3 agents → 3 distinct outputs, different focus and angle) — never
  disguised as an LLM; every output carries the honest engine label.

Gates: tsc clean · **224/224 tests** · production build clean · live E2E for
both rooms verified on the running server.

---

## Generative Arcade + Space missions, watchers, GitHub (2026-10-06)

**Arcade — generative forge (any game).** New `/api/arcade/forge` +
`✨ Generate any game` button: a construction-knowledge prompt (game loop,
input, collision/physics, states, scoring, enemy AI, juice, audio,
persistence, robustness — the full single-file game checklist) turns any
reachable model into a game builder. Pipeline: generate → extract →
validate → ONE repair round with the validator's real complaints → persist
(engine `ai-codegen`). Honesty gates: if the request falls back to the
deterministic Local Engine it returns 503 explaining exactly what to connect
(free Groq/OpenRouter key, on-device WebLLM, TurboAgent) instead of
pretending prose is a game. The template forge remains the instant offline
floor (now 8 engines incl. Tetris + 2048).

**Spaces — build missions (the mini-computer).** Each space gets a real
workspace directory (`.data/space-workspaces/<id>/`). A mission = goal +
time budget + agent pipeline (the space's fleet, or Planner → Builder →
Reviewer by default). Agents emit JSON action turns; the runner executes
them through a journaled tool surface: `write_file/read_file/list_files/
delete_file`, `run_command` (allowlist: node/npm/npx/git/python3/ls/cat,
20s timeout, cwd = workspace), `fetch_url` (capped), and `github_publish`
(blobs→tree→commit→ref via the GitHub REST API — no git binary; token from
the request or GITHUB_TOKEN; honest "not connected" otherwise). Time budget
hit → `checkpointed` with the current handoff; Resume continues at the next
agent. Every turn is journaled (tool, input, real output, ms) and persisted
(space_missions table, DB-first with memory fallback). Local Engine agents
plan but cannot emit actions — the mission says exactly that in its status.

**Spaces — watchers (recurring real observation).** A space can watch a
YouTube channel or playlist: every tick fetches the channel's RSS feed
(free — no API key, no quota), diffs against the seen set, and feeds new
titles + descriptions into the run's prompt, appending durable notes to the
briefcase. @handles resolve best-effort from the channel page. Fetch
failures are recorded verbatim as the run's output (verified live: sandbox
network blocks youtube.com → `watch failed: fetch failed`, honestly).

**Verified live:** mission machinery end-to-end (3-agent plan, 9 journal
steps, honest no-action failure with Local Engine; full action loop proven
by a scripted-model test — files land on disk, `node hello.js` executes,
github_publish honestly disconnected, artifacts + handoffs recorded);
generative forge 503 honest in-sandbox; watcher space persists config and
records real fetch results. Gates: tsc clean · **233/233 tests** · build
clean.

---

## Pre-wired free brain (2026-10-06)

The model layer already routes any text alias through the best connected
provider (Groq key → groq:free → OpenRouter free → TurboAgent → keyless
Pollinations → honest Local Engine). What was missing was making that
discoverable and actually used:

- **lib/connectedBrain.ts** — pure `pickBrain(keys)` resolution (groq →
  openrouter → turboagent → local) + client readers; 5 unit tests incl.
  precedence and blank-key handling.
- **BrainCard component** — mounted in Spaces (above the new-space form)
  and Arcade (above the model loader): shows which brain will actually run
  right now; when nothing is connected, an inline 3-step Groq walk-through
  (console.groq.com/keys → create key → paste; key stored in localStorage
  only) with alternatives (OpenRouter, TurboAgent, on-device WebLLM). After
  connecting: "agents, missions, and generation now run on Groq's free
  tier."
- **The real gap, fixed: keys now travel with every space call.** Fleet
  runs and mission runs previously sent no keys — agents silently degraded
  to the Local Engine even with a key connected. Both now send
  `keys + privacyFlags`; Run Now and tick already did. Mission default
  agent plans use a real alias (not local-engine) so a connected key — or
  keyless Pollinations where reachable — powers them; offline they degrade
  with honest labels.
- AgentFleet's default model for new agents now resolves from the
  connected brain instead of hardcoding local-engine.

Verified live: fake-Groq-key fleet run shows the honest chain
(`backend=arena-local-engine via=offline-fallback fallback=true` — key
routed, network-blocked in sandbox, honestly labeled; a real key on a real
machine runs groq:free). DB persistence confirmed post-schema-push.
Gates: tsc clean · 238/238 tests · build clean.

---

## Mission capability upgrades — closing the coding-agent gap (2026-10-06)

Four upgrades targeting the honest gaps vs. Copilot/Replit-class coding agents:

1. **maxTokens plumbing** — `GenerateOpts.maxTokens` now flows to every
   provider body (Groq, OpenRouter, Pollinations-OpenAI, TurboAgent) as
   `max_tokens`. Missions call with an explicit 8k cap; the generative game
   forge with 16k. No more silent truncation of long code.
2. **search_code tool** — recursive regex (or literal-fallback) search
   across the workspace with file:line results, glob filter, capped
   matches; pure Node, skips .git/node_modules. Agents can now explore
   existing codebases ("modify my app" tasks become possible).
3. **run_tests tool + the observation loop** — auto-detects `npm test` or
   Node's built-in `node --test` (60s budget; custom command still
   allowlist-checked). THE structural fix: mission context now includes
   OBSERVATIONS — the actual outputs of the last two steps' tool calls —
   so agents see test failures and command output and fix their work.
   Proven by a scripted-model test: write failing test → run (fail, output
   fed back) → fix → run (green), handoff "fixed and green". Also:
   `run_command`/`run_tests` children run with a sanitized env (no leaked
   NODE_TEST_CONTEXT — nested `node --test` would silently no-op).
4. **Configurable budgets + opt-in wider allowlist** — missions accept
   `maxTurnsPerAgent` (up to 16), `maxActionsPerTurn` (up to 12), and
   `extraCommands` (extra allowlisted binaries, opt-in only, name-validated).
   MissionPanel exposes turns selector + extra-commands input (⚙).

Gates: tsc clean · **244/244 tests** (15 in the spaces suite: +6 new —
search, run_tests×2, extra-allowlist, feedback loop, forge 16k cap) ·
build clean · live route checks (knobs accepted + clamped, honest Local
Engine status, pages 200).

---

## Mission intelligence additions — research-grounded (2026-10-07)

Researched current coding-agent practice (Aider edit formats & benchmarks,
SWE-agent's Agent-Computer Interface paper, Reflexion) and implemented the
five findings with the strongest evidence:

1. **`edit_file` — Aider-style SEARCH/REPLACE** (files >~400 lines use ~10×
   fewer tokens than whole-file rewrites). Guards against the documented
   failure modes: unique-match enforcement (ambiguous matches refuse with
   "include more surrounding lines"), CRLF/whitespace-drift tolerance,
   exact-text guidance, honest per-edit results — never "applied 0 of N
   edits" reported as success. Post-edit redisplay: numbered window around
   the changed region (SWE-agent's "edit command redisplays the update").
2. **Syntax guardrails** (SWE-agent: removing linting costs ~3 pts;
   guardrails stop cascading edits). write_file and edit_file on
   .js/.mjs/.cjs run `node --check`; .json parses; broken writes are NOT
   written, broken edits are REVERTED and reported with the real parse
   error. Other types honestly report "not checked".
3. **Windowed file viewer** (SWE-agent ACI: bounded views beat unbounded).
   read_file is now line-numbered with startLine/endLine windows (default
   first 100 lines) + "N more lines" hints — compact, information-dense
   feedback instead of 8KB dumps.
4. **Workspace map** (Aider's highest-praised context abstraction): every
   agent turn now carries the workspace file tree — orientation without
   scanning every file.
5. **Reflection memory** (Reflexion: stored lessons from failures carried
   forward): agents append lessons to AGENT_NOTES.md at mission end;
   subsequent missions in the same space get a MEMORY section injected.
   Plus an AGENT_KNOWLEDGE system-prompt base: plan→act→verify discipline,
   surgical edits, "self-correct with a hypothesis, don't blind-retry",
   never claim unverified work.

Tests: 249/249 — 5 new suites: edit_file apply/redisplay, honest
not-found/ambiguous refusals, guardrail rejection+revert for broken
JS/JSON writes and edits, windowed viewer, and map+memory injection across
two sequential scripted missions (lesson written in mission 1 is present in
mission 2's context). Live: API surface green, honest statuses, pages 200.

---

## Navigation & presentation overhaul (2026-10-07)

User complaint: decision paralysis — 22 same-weight nav links, walls of text,
ambiguous affordances ("hard to tell what's a button"). Presentation-only
pass; zero features or code removed:

- **Affordance layer (globals.css)**: Tailwind v4 preflight sets buttons to
  cursor:default — restored pointer cursors on all interactive elements
  app-wide, plus press feedback (active:translateY) and focus-visible rings
  on everything (links, buttons, inputs, selects). Added `.btn` base class
  and `.section-label` micro-label token for consistent hierarchy.
- **Nav rebuilt**: a 3-item primary rail (Arena · Chat · Spaces) + one
  "Rooms" launcher button opening a grouped, type-to-filter menu
  (Start here / Agents & teams / Create / Work & study / Results & records /
  System) with one-line descriptions. Ctrl/⌘+K toggles it anywhere; Enter
  opens the first match; Esc/click-outside closes; the rail shows the
  current room's identity when you're deeper in the app. All 23
  destinations verified present in the shipped chunk; mobile uses the same
  grouped launcher. Bonus: Cut Lab (/cut) was previously unreachable from
  the nav — now listed.
- **Home rebuilt around one decision**: 8-word subtitle (was ~70), one
  primary CTA (Command) + one secondary (Browse rooms); the 9-pill pile
  replaced by a Quick-launch grid (8 cards, one line each, "New" badges on
  Arcade/Collab); the 3-levels explainer demoted to a single quiet link to
  /runtime. KeysBar, BattleArena, and value cards unchanged.
- **Footer**: one quiet line with the same links (Privacy, Principles).

Verified live: all 24 routes 200, pointer-cursor + focus-ring CSS in the
served stylesheet, nav chunk contains every destination, home renders the
new hero/quick-launch. Gates: tsc clean · 249/249 tests · build clean.

---

## Windows field-report fixes (2026-10-07, from the user's machine)

First real run on Windows surfaced three issues — all fixed:

1. **`spawn npm ENOENT` (real product bug on Windows)** — npm/npx on
   Windows are `.cmd` shims; Node's spawn cannot execute them without a
   shell. `run_command`/`run_tests` now spawn with `shell: true` on win32
   only (posix behavior unchanged, no shell). The syntax guardrail's
   `spawnSync("node", …)` became `spawnSync(process.execPath, …)` — the
   absolute node binary running the app, correct on every platform with no
   PATH lookup.
2. **Turbopack build warnings** — gone: the "Can't resolve ('--check')"…
   warning disappeared with the non-literal execPath form, and the
   NFT whole-project trace warning is fixed with the documented
   `/*turbopackIgnore: true*/` comments on the dynamic `process.cwd()`
   resolutions in spaces/tools.ts and waveyard/storage.ts. Fresh build:
   zero warnings.
3. **Stale `.next/dev/types/validator.ts` breaking `tsc --noEmit`** —
   dev-server typegen artifacts (corrupted by interrupted runs/branch
   switches) were inside tsconfig's include. `npm run typecheck` is now a
   self-healing script (scripts/typecheck.mjs): removes `.next/dev/types`
   (the dev server regenerates it) then runs the project tsc.

Also: **security bumps from the user's npm audit** — next 16.2.6 → 16.3.8
+ eslint-config-next 16.3.8 + postcss 8.5.29. The critical (Next.js
middleware bypass / Server Actions DoS & SSRF, GHSA-6gpp-xcg3-4w24 et al.)
is eliminated: audit went from 14 (1 critical) → 10 (0 critical; remaining
are dev-tooling transitive deps whose forced fix is a breaking
eslint-config-next downgrade — deliberately not taken).

Gates on Next 16.3.8: tsc clean · 249/249 tests · build clean with zero
warnings · live smoke (pages, studio health, space create/delete) green.
Note: the Windows ENOENT fix itself is verified by construction + the
documented Node behavior for .cmd shims — the sandbox is Linux, so the
user's `npm test` on Windows is the true confirmation.
