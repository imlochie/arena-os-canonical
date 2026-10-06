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
