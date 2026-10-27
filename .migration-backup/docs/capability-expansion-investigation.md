# Capability Expansion Research & Gap Analysis — Investigation Report

**Date:** 2026-10-11 · **Branch:** `arena/01a10c30-arena-os-canonical` · **Head:** `099157a`
**Scope:** the mandate of 2026-10-11 (Digital World Audit framing + capability-expansion
investigation). This is an investigation, not an implementation: **no capability code was
written during it.** The only artifacts produced are this document and the evidence below.

## Method & evidence record (what was actually done)

- **Runtime validation:** full test battery on this exact tree (`npm test` =
  `src/**/*.test.ts` + `desktop/**/*.test.ts`): **1189 tests / 1189 pass / 0 fail, EXIT:0**. Prior same-session
  batteries on the same lineage: 1161/1161 (wave 5), 1181/1181 (wave 6a), 1189/1189
  (wave 6b). Live-over-HTTP proofs this session: toolbox convert flow, local-library
  connect→sync→range-stream→transcode→watch-progress, IMAP email login, archive
  reconciliation.
- **Static inspection:** full room/route/lib census (43 rooms, 60+ API route families,
  115 top-level lib modules, 151 test files), symbol-level reads of the agent stack
  (`toolRuntime`, `spaces/*`, `deepAgent`, `foundry`, `orchestrator`, `workforce*`,
  `workerExecutor`, `executionPolicy/Session`, `repoMap`, `chatRunner`, `projectContext`).
- **External inspection (cloned at `--depth 1`, real code read):** universal-modder
  (MIT), agentskills (spec), browser-use (MIT), gemini-cli (Apache-2.0), OpenHands
  (MIT), storytold/photocraft+vectorcraft+filmcraft+lightcraft (MIT/Apache-2.0, Rust).
  n8n license text fetched via GitHub API (Sustainable Use License). Shodan client
  located (`achillean/shodan-python`, stale since 2024-08).
- **Fetched live:** ideawave.io, arrfounder.com, trustmrr.com, perchance.org.
- **Not inspectable from this environment:** Start.me and WorldCam were assessed at
  product-pattern level only (no fetch); Chromium cannot be installed here, so no
  browser automation could be executed end-to-end (see §8); e2e Playwright specs exist
  (`tests/e2e/*.spec.ts`) but have never been run in this sandbox.

---

## 1. Executive findings

1. **Arena is far more capability-complete than the mandate assumes.** The mandate's
   checklist — agents, missions, tools, permissions, approvals, execution boundaries,
   handoffs, artifacts, workspace maps, browser automation, background execution —
   all have real, tested implementations in this repo (§2). The highest-value "new
   capabilities" are mostly **connectors and consolidations over existing primitives**,
   not new subsystems.
2. **The mandate's delivery-sequence premise does not match this repository.**
   "Waveyard G6" does not exist here (the waveyard lineage in this branch is V6, the
   library bridge), and "Forge" exists only as the corrected legacy PWA brand
   ("ArenaForge Personal") plus the Arcade game forge — there is **no Forge coding-agent
   runtime, schema, or doc** in this tree. If G6/Forge live in another session's branch,
   this report's sequencing keeps clear of them; the recommendations below touch neither.
3. **The single best-evidenced gap is consolidation, not invention:** the user's
   **Digital World Audit** (their framing at the top of the mandate) can be built
   almost entirely from existing, tested rooms — device-security (honest local
   observation), subscriptions (+ IMAP receipts), model-hub (AI stack inventory),
   archive/toolbox/watch (media footprint), mind (capture), projects/handoffs (work
   graph) — plus one new read-only inventory scanner and a findings model that
   mirrors the already-proven mediaArchive reconciliation/review pattern (§5.1, §13).
4. **The learning loop the mandate describes already exists as a *pattern* in
   universal-modder** (front-mattered field notes with honest status + generated
   index + a skill that teaches agents to write notes). Arena has all the storage
   primitives (mission journals, artifacts, mind captures) but **no retrieval-of-prior-
   solutions seam**. Smallest useful extension: a field-notes convention over existing
   tables, not a new memory system (§7).
5. **Browser automation is Phase C of a shipped-phase roadmap** (`spaces-autonomy.md`):
   governance-gated tools exist (`browser.ts`: navigate/extract/screenshot auto-execute;
   click/fill approval-gated; per-space profiles; honest no-Chromium errors). What's
   missing is a **real end-to-end pilot on a machine with Chromium** — impossible in
   this sandbox. browser-use itself (Python, MIT) is not recommended as a dependency;
   Arena's own implementation is ahead on the governance dimension (§8).
6. **n8n is rejected for embedding** — Sustainable Use License (not OSI), `.ee.*`
   files enterprise-only, non-main branches unlicensed; a hosted/optional-adapter
   posture is possible later but no current Arena workflow needs it (§12).
7. **The ArtCraft suite (photocraft/vectorcraft/filmcraft/lightcraft) is real,
   actively maintained (commits within the last 2 days), dual-licensed MIT/Apache,
   500–1,100 Rust files each, and lightcraft is explicitly MCP-drivable.** They are
   companion desktop apps, not embeddable libraries. The correct integration is an
   **MCP tool adapter** behind Arena's existing governance — deferred until a generic
   MCP adapter exists (§10, §13).
8. **Startup-intelligence sites are consumer databases with self-reported or
   mixed-provenance revenue data** (IdeaWave's own money page currently renders a
   *negative* combined MRR; Arrfounder's "verified" ARR rows are founder-bio claims).
   The useful takeaway for Arena is a **research-to-brief workflow with provenance
   labels** (observed fact vs. third-party estimate vs. marketing claim), built on the
   existing creative/research citation machinery — not any site integration (§11).
9. **A Capability Registry is justified only as a convention, not a subsystem.**
   Arena already has four fragment-registries (toolRuntime capabilities, arenaRooms,
   modelHub registry, repoMap). The additive move is an **Agent-Skills-compatible
   manifest format** (`SKILL.md` + front matter, instructions strictly separated from
   tool grants) indexed into an existing table — no new service (§6).
10. **The mock-LLM eval discipline from OpenHands** (Playwright suites against a
    scripted LLM server, no real credentials) is directly transplantable to Arena's
    e2e gap and is the cheapest reliability win in this report (§9, §13).

---

## 2. Actual Arena capability inventory (with evidence)

Classification: **[1]** implemented+verified (repeatable execution evidence) ·
**[2]** implemented but unverified · **[3]** partial · **[4]** documented/planned ·
**[5]** absent · **[6]** broken/contradicted.

| Capability | Where | Class | Evidence & limits |
|---|---|---|---|
| Blind model battles + ELO | `battles`, `elo.ts`, `ratings.ts` | [1] | Long-lived core; battery-covered |
| Direct chat w/ provider abstraction | `chatRunner.ts`, `ai.ts`, `models.ts`, `connectedBrain.ts` | [1] | chat route tests 6/6 this session |
| Multi-worker reasoning (Council/Congress/Collab) | `councilSynthesis.ts`, `congress.ts`, `completeCouncilSession.ts` | [1] | Integration tests green in battery |
| Workforce allocation + fallback | `workforceRuntime.ts`, `workerExecutor.ts`, `workerSuitability.ts` | [1] | Unit+integration tests in battery |
| **Missions (agent loops)** | `spaces/mission.ts` (journal, steps, `parseAgentJson`), `runMission` | [1] | `spaces-tools.test.ts`, governance tests; live daemon |
| **Tool governance + approvals** | `spaces/governance.ts` (action classes, append-only ledger, single-claim, sha256 action signatures), `/api/spaces/approvals` | [1] | `governance.test.ts` green; Phase A shipped |
| Background execution | `npm run spaces:daemon` (opt-in) | [1] | Documented + shipped Phase A |
| Workspace isolation | `spaces/workspace-isolation.ts` | [1] | Test green; Phase B shipped |
| **Browser automation** | `spaces/browser.ts` (navigate/extract/screenshot auto; click/fill approval-gated; per-space profiles) | [2] | Code + `browser.test.ts` exist; **no end-to-end run possible here (no Chromium)** — Phase C 🚧 |
| Watchers/scheduling | `spaces/watchers.ts` (YouTube channel/playlist) | [1] | Tests green; watcher config persists |
| Read-only repo tools w/ grants | `toolRuntime.ts` (`filesystem.list/read/search`, `git.status/diff/log`), `toolEffects.ts`, `toolEffectService.ts` | [1] | `toolRuntime.test.ts` + integration test green |
| Deep agent (bounded plan→act→verify) | `deepAgent.ts` (MAX_STEPS=8, verdict parser, transcript) | [1] | Battery-covered; honest caps |
| App builder (sandboxed) | `foundry.ts` (CSP injection, KV caps, versioned apps) | [1] | `foundry.test.ts` green |
| Orchestrator (multi-participant relay) | `orchestrator.ts` (1,167 lines; trust levels, classification) | [1] | Battery-covered |
| Repo/workspace maps | `repoMap.ts` (58 lines, exports per file), `/api/repo-map` | [1] | Small but real; battery-covered |
| Project shared context | `projectContext.ts`, `projects` room | [1] | Battery-covered |
| Artifacts + provenance | `artifacts` room, `api/artifacts`, `deviceArtifacts.ts` | [1] | Battery-covered |
| Handoffs | `arenaHandoffs.ts`, `handoffs.ts`, `/handoffs` ledger | [1] | Battery-covered |
| **Memory/capture** | `mind.ts` (auto-tagged, searchable, no folders) | [1] | `mindApps.test.ts` 5/5 |
| Reflection/lessons | `college/faculty-memory.ts` (college-scoped only) | [3] | **No cross-mission lessons primitive** (§7) |
| Email (real IMAP login, sealed creds) | `emailInbox.ts`, `secretBox.ts` | [1] | 7/7 incl. real RFC-3501 server |
| Media archive (native merge) | `mediaArchive/*` (plex/jellyfin/local sync, reconcile, review, lineage) | [1] | 6/6 + 4/4 + 8/8 this session |
| Local conversion (HandBrake replacement) | `toolbox/*` | [1] | 13+7 tests, live HTTP proof |
| Local library + streaming + watch state | `mediaArchive/local.ts`, `/api/library/*`, `/watch/[id]` | [1] | 8/8 tests, live HTTP proof |
| Creative suite (research/slides/podcast/voice/captions/shorts) | `creative/*` | [1] | `creative.test.ts` green |
| Model hub (runtimes, registry, agent bridge) | `modelHub/*` | [1] | 4 test files green |
| Identity/authN (WebAuthn, ceremony, device identity) | `webauthn*.ts`, `authenticationCeremony.ts`, `identityService.ts` | [1] | Integration tests green |
| Authorization/policy | `authorization.ts`, `executionPolicy.ts`, `executionConfig.ts` | [1] | Integration tests green |
| Execution sessions/events | `executionSession.ts`, `sessionEvents.ts`, `sessionLifecycle.ts` | [1] | Integration tests green |
| Local/offline inference | `localEngine.ts`, `webllm.ts`, runtime levels | [2] | Code + unit tests; **no live local-model run in this environment** (no Ollama here) |
| Desktop (Electron, embedded PG, staged build) | `desktop/`, `scripts/desktop-*` | [1] | Desktop suites 81/81; Windows acceptance only if really run (standing rule) |
| CI | `.github/workflows/ci.yml` | [1] | Static gate + compose smoke; "green-by-construction" honest header |
| e2e browser tests | `tests/e2e/*.spec.ts` | [4] | Specs exist; **never executed here** |
| External action surfaces (calls/SMS/payments) | — | [4] | Phase D of spaces-autonomy, planned |
| MCP client support | — | [5] | No MCP adapter anywhere in `src/` |
| Generic capability/skill packaging | — | [5] | No SKILL.md-style format (§6) |
| Cross-mission field notes / solution retrieval | — | [5] | The §7 gap |
| Digital World Audit (whole-life view) | fragments only | [3] | §5.1 |

Prior in-repo audit `docs/arena-product-audit.md` (1125/1125 at its time) remains
accurate in its hole-list where not since fixed; this report inherits its corrections.

---

## 3. Architecture & dependency map (as-is)

```
Next.js 16 (App Router, 43 rooms) ──┬── src/lib (115 modules, the real product)
                                    ├── 60+ API route families
                                    ├── Drizzle ORM ── embedded PostgreSQL (local-first)
                                    ├── Electron desktop shell (staged standalone server)
                                    └── CI: static gate + compose smoke

Agent stack (the mandate's focus):
  chatRunner / orchestrator / council / congress / collab   ← cognitive surfaces
        └── workforceRuntime ── workerExecutor ── ai.ts (provider abstraction)
  spaces (missions) ── mission.ts (journal, agent JSON loop)
        ├── tools.ts + governance.ts (action classes → approval ledger)
        ├── browser.ts (Phase C, playwright-core, per-space profiles)
        ├── workspace-isolation.ts (Phase B)  └── watchers.ts + daemon (Phase A)
  toolRuntime.ts (read-only filesystem/git tools under explicit grants)
  deepAgent.ts (bounded autonomous loop) · foundry.ts (sandboxed app builder)

Data/assets: archiveItems(+mind) · artifacts · projects · subscriptions ·
  emailAccounts (sealed) · mediaProviders/mediaLibraryItems (plex/jellyfin/local) ·
  toolbox scratch · library-cache
```

Boundary notes: waveyard (music studio) and studio (visual gen) are rooms in this
repo with their own worker surfaces (`waveyard/worker-local`, `studio/`); the
mandate's "do not merge Arena and Waveyard" constraint is moot *within this branch*
(they already share the database as rooms of one personal product) — if the mandate
refers to the separate waveyard product line from sibling sessions, nothing in this
report changes that topology.

---

## 4. External project comparison matrix

| Project | What it actually is (evidence) | Arena equivalent today | Exact gap | Recommendation |
|---|---|---|---|---|
| **universal-modder** (MIT) | Skills (SKILL.md, Agent-Skills format) + `knowledge/` field notes (front matter: engine/route/**status working·in-progress**/agents/date) + generated `INDEX.md`/`index.json` + `share-field-notes` skill + `um` CLI + fal MCP | mission journals, artifacts, mind captures — but no retrieval-of-prior-solutions, no status-honest notes convention | Post-mission field notes + pre-mission retrieval + supersession rules | **Adapt the convention** (§7) — smallest useful extension |
| **gemini-cli** (Apache-2.0) | TS agent CLI: rich tool suite (edit/glob/grep/plan-mode/`activate-skill`/`ask-user`/`complete-task`), confirmation policies, extensions, hooks, hierarchical GEMINI.md context | spaces tools + governance cover most; repoMap covers workspace context; AGENTS.md exists at repo root | Plan-mode as a first-class mission phase; hooks; hierarchical instruction files per project | **Borrow patterns** (plan-mode, per-project instruction file); do not adopt as engine |
| **agentskills** (spec) | Folder + SKILL.md (name/description front matter + instructions), progressive disclosure (discovery→activation→execution), optional scripts/references/assets | nothing | A portable capability packaging format | **Adopt the convention** for a registry manifest (§6); instructions never grant tools |
| **OpenHands** (MIT) | Now a TS/Electron app; **mock-LLM Playwright e2e configs** (bind-policy, live, mock-llm, mock-llm-docker), scripted LLM server so e2e needs no credentials | missions resume via daemon; e2e specs exist but never run | mock-LLM e2e discipline; explicit resumability semantics | **Borrow the eval pattern** (§9); architecture not needed |
| **browser-use** (MIT, Py) | Playwright-based DOM agent (actor/dom/controller/mcp), LLM-driven, active (2026-10-07) | `spaces/browser.ts` — governance-gated, profile-isolated, honest errors | Only a real end-to-end pilot is missing | **Keep Arena's own**; run the pilot on a Chromium machine (§8) |
| **n8n** (Sustainable Use License) | 207k★ workflow automation; `.ee.*` enterprise-only; non-main branches unlicensed | watchers + daemon + missions cover personal automation | None demonstrated | **Reject embedding**; optional webhook adapter only if a concrete need appears |
| **ArtCraft suite** (MIT/Apache, Rust) | Clean-room Photoshop/Illustrator/Premiere/Lightroom; 508–1,095 .rs files each; commits 2026-10-10/11; lightcraft "drivable by AI agents over MCP"; filmcraft ships `.mcp.json` | LUMA (AI image workshop), Cut Lab (split), Studio (gen), waveyard (audio) | Full manual photo/vector/video/raw editing; MCP tool surface | **Defer**; build the generic MCP adapter first (§10) |
| **IdeaWave / Arrfounder / TrustMRR** (sites) | Daily "validated" ideas over a 1,034-startup revenue DB (mixed payment-verified + **self-reported**; money page currently shows a *negative* combined MRR); founder directory with ARR from public claims; small-SaaS buy/sell marketplace | creative/research (citations), projects | Research→opportunity-brief workflow with provenance labels | **Build the workflow, integrate none** (§11) |
| **Shodan** (+ `achillean/shodan-python`, stale 2024-08) | Internet-exposure search API; client lib dormant | device-security room (honest local observation) | Authorised own-asset infrastructure research | **Defer** — narrowly-scoped adapter design exists in §12, no build |
| **Perchance / Start.me / WorldCam** (sites) | Text-DSL random generators (shareable, offline-HTML export); bookmark startpages; map-based webcam portal | Arcade (games+generators), mind (links) | None demonstrated | **Reject** as subsystems; Perchance's weighted-list DSL is a possible Arcade input format someday |

---

## 5. Capability gap analysis

### 5.1 The Digital World Audit (the user's framing) — assessed against the repo

The user's six audit domains map onto existing, tested surfaces more than expected:

| Audit domain | Exists today (evidence class) | Real gap |
|---|---|---|
| 1. Devices & environment | `device-security` room ("what Arena can honestly observe") [1]; desktop runtime status | Cross-device inventory, external-drive enumeration, redundant-software detection — **scanner breadth**, not a new model |
| 2. Files & data universe | archive index (name/kind/size/hash/dedupe) [1], toolbox, local library scanner (ffprobe walk) [1], mind | A **generalized discovery scan** (any folder, all file types, duplicate/orphan/backup-gap findings); the local-library walker is 80% of the pattern |
| 3. Accounts & online identity | email accounts (IMAP, sealed) [1], subscriptions [1] | Account inventory from authorized sources only; **no scraping** — this stays conservative |
| 4. Security & privacy | device-channel threat model, webauthn, secretBox, privacy room [1] | Correlation of findings into risks; external checks stay out of scope by design |
| 5. Subscriptions & spend | subscriptions room + IMAP receipt extraction [1] | Overlap detection, verified-billing-only claims (already the honest posture) |
| 6. Infrastructure & creative ecosystem | model-hub (AI stack) [1], projects/handoffs (work graph) [1], studio backends | A connected graph view + broken-connection findings |

**Verdict:** the Digital World Audit is the highest-value next capability *precisely
because it is mostly consolidation*: one read-only discovery scanner + a findings/
review workflow cloned from the proven mediaArchive reconciliation pattern
(observations → review items → evidence lineage → approve/dismiss, never auto-act)
+ an aggregation room. Discovery-not-inspection (the user's crucial difference) is
satisfied by the scanner surfacing *unknowns* (untracked drives, no-backup folders,
overlapping services) rather than checking a fixed list.

### 5.2 Other confirmed gaps

- **G1 — Cross-mission knowledge reuse** (§7): no retrieval of prior verified
  solutions before a mission runs. Highest leverage per line of code.
- **G2 — MCP client adapter** (absent): blocks the entire ArtCraft-class (and fal,
  and future local-tool) integrations behind one well-governed seam.
- **G3 — Real e2e verification** (§8/§9): e2e specs exist but have never executed;
  no mock-LLM harness. Everything "verified" today is verified at the unit/integration
  or live-HTTP level, not at the UI level.
- **G4 — Plan-mode mission phase** (gemini-cli pattern): deepAgent has plan→act→verify
  but missions don't expose an inspectable plan checkpoint.
- **G5 — Capability packaging** (§6): no portable skill format; assistants are
  personas, not procedures.

---

## 6. Capability Registry — investigation verdict

**Existing fragments:** `toolRuntime.ts` already defines capability IDs +
grants (`filesystem.read` etc.) — the Tools half of the model; `arenaRooms.ts`
is a room registry; `modelHub/registry.ts` a model registry; `repoMap.ts` a
workspace index. **Nothing represents a *versioned procedure with verification
criteria*.**

**Verdict: adopt the Agent Skills convention, not a new subsystem.**

- A capability package = folder with `SKILL.md` (front matter: name, description,
  version, inputs/outputs, verification criteria, provenance) + optional
  references/assets. Instructions are **data**, never authority: a skill may only
  *request* tool classes; grants flow exclusively through `governance.ts` action
  classes and existing `ToolGrant`s. This is the mandate's "a skill must not grant
  itself authority" rule, and Arena's governance ledger is already the enforcement
  point.
- Progressive disclosure (discovery→activation) matches how assistants/missions
  already assemble prompts; the index can live as rows in an existing table
  (e.g. alongside artifacts) — **no new service, no new DB machinery in this step**.
- Install/update/remove = git-tracked folders in-repo first; third-party skill
  installation is explicitly **out of scope** until script isolation exists.

---

## 7. Knowledge & learning loop — design grounded in universal-modder

What universal-modder proves (99 game notes, agent-authored, honest `status`
column with `working`/`in-progress`, engine/route metadata, dated, indexed):

1. **Notes are written by the agent that did the work**, from a template, with
   front matter (subject, environment, status, date, author-agent).
2. **An index is generated from front matter** (`um kb index`), never hand-edited.
3. **Retrieval happens before execution** (skills say "check the KB first").
4. **Honesty is structural**: `in-progress` ≠ `working`; dead ends are recorded
   (e.g. "ReShade render depth does not [work]").

Arena mapping (before/during/after, per the mandate):

- **Before:** mission prelude retrieves notes matching repo+task+environment from
  an existing store (mind items with a `field-note` kind or an artifacts query);
  staleness check = front-matter date + repo/state version.
- **During:** `mission.ts` journal already records every action + observation —
  the raw material exists today.
- **After:** on mission completion, prompt the worker to write one field note
  (template + front matter incl. status, evidence links to journal/artifacts).
  **Supersession:** a newer note with matching scope supersedes; notes carry
  confidence; retrieval presents "last verified <date>" rather than asserting truth.
- **Guardrails:** never auto-promote a note to system prompt; notes are advisory
  context; secrets excluded (governance redaction already exists).

Cost: a template, a retrieval query, a post-mission hook. No new memory system.

---

## 8. Browser / computer-use assessment

**Arena today (`spaces/browser.ts`, Phase C 🚧):** real DOM via playwright-core;
per-space persistent profiles (isolation by construction); `view` class
(navigate/extract/screenshot) auto-executes and journals; `interact` class
(click/fill) is **approval-gated through the same ledger as everything else**;
honest no-Chromium errors (never a fabricated page); screenshots land in the
workspace as artifacts. `browser.test.ts` covers the surface at unit level.

**browser-use comparison:** mature DOM extraction and LLM orchestration, but it is
a Python dependency that wants to *be* the agent, while Arena's value is exactly
that the browser is one governed tool among many behind the mission loop. Arena's
implementation is ahead on isolation, approval, and honesty; behind on extraction
richness and real-world mileage.

**The mandate's rule — "evaluate one realistic task end to end before recommending"
— cannot be satisfied in this sandbox (Chromium uninstallable).** Therefore browser
automation is recommended as: **complete Phase C on the owner's machine** with a
defined pilot (below), not as an adopted dependency.

**Pilot protocol (proposed):** one mission, one real site, three steps — navigate,
extract (assert DOM text matches a known value), screenshot (assert artifact
bytes + journal entry) — plus one approval-gated click refused-then-approved, with
the ledger as the audit record. Success = structured evidence in the journal, not
prose.

---

## 9. Mission lifecycle & workflow assessment

**Present:** `runMission` with a journal; `awaiting_approval` checkpoint + Resume;
single-claim execution; append-only decisions; opt-in daemon advancing due runs;
workspace isolation. This is already beyond "prompt loop" stage.

**Gaps vs. the mandate's list:** durable checkpoints *between* daemon restarts are
journal-implicit but not snapshot-explicit; idempotency is enforced at the action
signature level (re-execution blocked) but tool-level idempotency declarations
(the tool-runtime doc's own goal) are not yet implemented; no mock-LLM e2e.

**Smallest demonstrable improvements (in order):**
1. **Mock-LLM e2e harness** (OpenHands pattern): scripted worker responses →
   Playwright drives the real UI → mission runs end-to-end without credentials.
   This converts the e2e suite from [4] to [1] and is reusable for every room.
2. **Explicit checkpoint records** on phase transitions (plan→execute→verify),
   persisted from the journal — resumability becomes observable, not inferred.
3. Idempotency declarations on remaining write tools (toolRuntime doc already
   specifies the shape).

---

## 10. Creative-engine integration assessment (ArtCraft suite)

Functional, maintained (last commits 2026-10-10/11), legally clean (MIT OR
Apache-2.0), huge (500–1,100 Rust files each), native + WASM. They are
**applications, not libraries** — embedding is not on the table. The integration
surface that matters: **lightcraft is explicitly MCP-drivable; filmcraft ships
`.mcp.json`.**

Arena's gaps they would fill: full manual photo/raw/vector/video editing (LUMA/Cut
are AI-first, not editors). Arena's correct move: **build the generic MCP client
adapter (G2) with governance mapping** (MCP tool → action class → approval ledger),
then register any ArtCraft app the owner installs as a tool. Deferred order: MCP
adapter (small, unlocks a class of integrations) before any ArtCraft-specific work.

---

## 11. Startup-research workflow assessment

What the three sites actually are (fetched 2026-10-11): IdeaWave = daily idea
validation over a revenue DB (mixed payment-verified + self-reported sources;
its own stats page currently renders a **negative** combined MRR — a live
demonstration of why provenance labels matter); Arrfounder = founder directory
whose "verified" ARR rows trace to public bios/claims; TrustMRR = a small-SaaS
acquisition marketplace. None advertise public APIs on their landing pages.

**Recommendation:** build the *workflow*, integrate none of them. Arena's
creative/research already fetches with citations; projects + artifacts hold briefs.
A "discovery → evidence-backed opportunity brief" path needs: (a) a provenance
field on every claim (observed / third-party estimate / marketing claim), (b) a
brief template, (c) source traceability (URL + fetch date). Scraping or
redistribution: **no** — public visibility is not authorisation.

---

## 12. Security, licensing & operational risks

- **n8n:** Sustainable Use License — embedding/redistributing inside a clonable
  personal OS is a licensing trap; `.ee.*` files are enterprise-only. **Rejected
  for embedding.** Watchers/daemon/missions already cover the personal-automation
  need.
- **MCP trust model (future adapter):** an MCP server's tool descriptions are
  untrusted input. Tools must map to Arena action classes at registration time,
  with the human approving the mapping once — never dynamically per call.
- **Skill scripts:** the Agent Skills format permits executable scripts; Arena
  must not execute third-party skill scripts until workspace isolation covers
  them (Phase B isolation exists — extend it, don't bypass it).
- **Secrets:** sealed at rest (secretBox v1) across email/providers; field notes
  and artifacts must inherit the same redaction discipline (§7 guardrail).
- **Shodan (if ever built):** own-assets scope only (your IPs/domains), key sealed,
  queries journaled, results classified `internal`, no aggregation of
  third-party personal data — and Shodan ToS review first (not fetchable from here).
- **Browser profiles:** per-space isolation exists; keep credentials inside
  profiles, never in mission context.

---

## 13. Ranked implementation roadmap

**Tier 1 — immediate research/verification (no product code):**
1. Resolve the **G6/Forge premise mismatch** with the owner (this report §1.2) —
   it gates nothing here, but sequence claims should be reconciled.
2. Run the **browser Phase C pilot** on the owner's machine (protocol in §8).

**Tier 2 — next implementation candidates (proven gaps, narrow paths):**
1. **Digital World Discovery Scan + findings room** (§5.1) — reuses device-security
   posture, the local-library walker pattern, and the mediaArchive
   reconciliation/review machinery. Read-only by default, nothing auto-deleted,
   destructive actions separate and approved. *(The user's own top want.)*
2. **Field-notes learning loop** (§7) — template + retrieval + post-mission hook.
3. **Mock-LLM e2e harness** (§9.1) — converts the e2e suite to real evidence.
4. **Agent-Skills-compatible capability manifest** (§6) — convention + index only.

**Tier 3 — later opportunities (dependent on foundations):**
1. **Generic MCP client adapter** behind governance (§10) — then ArtCraft-class
   tools, fal, etc. register as tools.
2. Plan-mode mission phase + per-project instruction files (gemini-cli patterns).
3. Explicit checkpoint records + idempotency declarations (§9.2/9.3).
4. Shodan narrowly-scoped adapter — only if the Digital World Audit's
   infrastructure section demands it, after ToS review.

**Rejected/deferred:** n8n embedding (license + no demonstrated need);
browser-use as a dependency (own implementation ahead on governance); startup-DB
integrations (no APIs, provenance problems — workflow instead); Perchance/Start.me/
WorldCam as subsystems (no demonstrated user problem).

**Sequence interactions:** nothing above touches waveyard G6/Forge territory
(wherever it lives), modifies Remix behaviour, or crosses the mandate's
architecture boundaries. All Tier-2 items are additive, independently testable,
and ordered by user value.

---

## 14. Acceptance criteria & tests (per Tier-2 recommendation)

1. **Discovery Scan:** scanning an arbitrary fixture folder yields items with
   real size/hash/type (re-probed, not assumed); duplicates detected by content
   hash; findings carry evidence paths; review workflow approves/dismisses without
   mutating files; a no-backup finding fires for a fixture folder outside known
   backup roots; read-only guarantee asserted by comparing directory mtimes
   before/after scan. Tests: unit (parser/walker) + PG-gated integration
   (findings→review) + live-HTTP proof, mirroring `local.test.ts`'s structure.
2. **Field notes:** post-mission hook writes a note with front matter; retrieval
   surfaces notes matching a fixture repo/task with "last verified" labels; a
   superseded note is presented as superseded; secrets redaction test (a fixture
   secret never appears in a note).
3. **Mock-LLM harness:** a scripted-response server drives a real mission
   end-to-end through the API; the e2e spec asserts journal entries + artifact
   bytes, runs without network or credentials, and fails if the worker's claimed
   action didn't really execute.
4. **Capability manifest:** a fixture SKILL.md is indexed and discoverable;
   activation injects instructions only; a skill requesting a tool class it was
   never granted produces a governance refusal (the "no self-authority" test).

---

## 15. Unresolved questions & evidence still required

1. **Where do "Waveyard G6" and "Forge" live?** Not in this repository (§1.2).
   Owner input required before any sequencing that references them.
2. **Chromium pilot results** — browser Phase C cannot be verified from this
   sandbox by policy (no fabricated evidence); needs the owner's machine.
3. **Start.me / WorldCam** were not fetched (context budget); assessed at pattern
   level only. Nothing in the recommendations depends on them.
4. **IdeaWave/Arrfounder/TrustMRR ToS and API availability** — landing pages
   fetched; terms/API docs not inspected. Any future data access requires that
   review; the current recommendation needs none of it.
5. **Shodan ToS** — not fetchable from this environment; adapter design is
   contingent on it.
6. **Wave-6 screenshots** (standing item from the user's earlier queue) still
   never materialized in the sandbox.
7. Battery number for this exact run: **1189 tests / 1189 pass / 0 fail, EXIT:0** (recorded at top).
