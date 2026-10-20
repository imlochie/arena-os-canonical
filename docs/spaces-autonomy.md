# Spaces Autonomy Roadmap — genuine workspaces, strict check-ins

## Current product entry points and evidence

`/spaces` and the pop-out `/spaces/<id>` share the same Workshop components:
agent fleet, mission controls/history, output retrieval/reuse, request
reconciliation and human approvals. The pop-out defaults to Workshop; recurring
drafts, history and setup remain in their own tabs.

The mission evidence summary is a **view of stored observations**, not a new
runner or proof that a process is alive. It separates successful commands,
qualified machine-observed `run_tests` command outcomes, immutable output references,
unavailable outputs, uncertain outcomes and human reconciliation. A model saying
`done`, a historical unqualified observation, or owner review cannot create a
machine test-command success. Even a `run_tests` command can be arbitrary;
inspect the actual assertions/output rather than treating zero exit as proof
of passing tests. Failed runs remain visible even after a later successful
repair. The journal shows the actual reported backend/model and any fallback.
Passing a command/test does not establish the correctness of an entire product.

### Configuration and operational limits

The scheduler is request-driven, not an always-on service. Visible clients poll
recurring due spaces. `scripts/spaces-daemon.mjs` is a separate **opt-in** HTTP
client (`npm run spaces:daemon`; `-- --once` for one tick). Continuous polling
defaults to 60 seconds. The app and daemon need to remain running and authorised.
The daemon resumes its supported decided-approval waits; it is not a general
promise to restart every failed/checkpointed mission automatically.

PostgreSQL is required for durable requests/results and mission restart
recovery. Explicit memory-only missions cannot survive a restart. Browser tools
need an installed Chromium binary; live provider actions need configured
credentials and recorded decisions. Container mode needs Docker/Podman:
automatic host-jail fallback is **not** container/VM isolation. Current runtime
absence and unconfigured integrations must remain honest errors.

### Remaining gaps, not claims of completion

The existing `AGENT_NOTES.md` injection retrieves raw per-space notes, not a
verified cross-mission knowledge service. A small future field-note convention
can reuse owner/project-bound Artifacts: finding, source mission/request,
environment/version, outcome (`verified`, `hypothesis`, `failed`, `untested`),
evidence/checksum references and a superseded-revision reference. Retrieval must
remain ownership/workspace-scoped and must not promote model prose into fact.
That searchable convention is **not implemented by the Workshop UI increment**.

Tools and governance already exist; a unified preflight capability inventory
would still need real runtime probes, not a new registry or optimistic buttons.
Live external publishing, live model reasoning, actual containers and Electron
are separate acceptance boundaries. Controlled-agent regression tests prove
the exercised orchestration/tool/recovery paths, not general intelligence.

The focused Workshop acceptance must start from the actual Next page, execute
real workspace commands/tests, retrieve checksum-bound output Artifacts and
exercise restart/reconciliation without repeating an uncertain effect. Existing
governance/recovery/browser/isolation tests remain in place. Pending or failed
CI is not acceptance evidence; inspect the exact-revision receipts and logs.

This is the build program that takes Spaces from "prompt loops with a journaled
tool surface" to the user's stated goal:

> spaces build genuine Linux or Windows workspaces that run intelligent,
> autonomous, real building work — e.g. a few workers building and running a
> drop-shipping business in the background, viewing real websites and videos,
> creating real accounts, making real calls — inside a controlled, strict
> check-in environment.

Every phase is honest about what is real: nothing is simulated, nothing is
claimed that does not execute, and every consequential action passes through
the human check-in gate.

## Phase A — Governance + background execution ✅ (shipped)

**The strict check-in environment, wired into the mission runner.**

- `src/lib/spaces/governance.ts` — the action-class model and the approval
  ledger. Every mission tool maps to a class (`filesystem.read`,
  `filesystem.write`, `command.run`, `network.fetch`, `github.publish`,
  `browser.view`, `browser.interact`, `external.call`, `external.sms`,
  `payment.link`). The consequential classes — publish, browser interaction,
  calls, SMS, payments — are **approval-gated**: they never execute without a
  recorded human decision. The ledger is append-only in effect: decisions are
  terminal (denied stays denied), execution is single-claim (approved →
  executing → executed/failed; a second claim loses), and an action signature
  (sha256 over the exact action instance) binds re-emissions: an executed
  action is never re-run, a denied one is refused without a fresh request.
- The mission runner's action loop consults the gate before every tool call:
  pending → the mission checkpoints itself `awaiting_approval` and tells the
  agent exactly that; denied → honest refusal, agent adapts; approved →
  single-claim execution, journaled like every other action.
- `GET/POST /api/spaces/approvals` — the human decision surface.
- The Spaces workbench gained a **Check-in panel**: pending approvals with
  Approve/Deny, decision history, auto-refresh; `awaiting_approval` missions
  show a Resume button.
- `npm run spaces:daemon` (opt-in, never auto-started) — the background tick
  service: advances due space runs without any page open, auto-resumes
  missions whose approvals have been decided, and expires stale requests
  (default 24h) so nothing waits forever. It is just another HTTP client of
  the app — all governance applies.
- Schema: `space_action_approvals` (canonical `desktop-migrations/0007`,
  mirrored `drizzle/0020`).

What Phase A does NOT change: the tool surface stays allowlisted and
workspace-jailed; non-gated actions (reads, writes, allowlisted commands,
text fetches) execute as before, fully journaled.

## Phase B — Real workspace isolation (container/VM workspaces) ✅

Per-mission workspaces graduate from host directories to real isolated
environments: Linux containers (Docker/Podman) where available, WSL2 on
Windows. The tool surface stays identical — `run_command` executes inside the
container; the host is unreachable by construction.

SHIPPED (`src/lib/spaces/workspace-isolation.ts` + mission wiring): runtime
probe (docker → podman → wsl, real version output, never assumed — a bare
WSL distro is DETECTED for honest diagnostics but deliberately NOT used as
isolation: it shares the host's filesystem and network. On Windows the
container path is Docker Desktop's WSL2 backend or Podman; a wsl-only machine
gets the honest host-jail fallback, and `isolation: "container"` fails loudly
there instead of pretending), one
long-lived container per space workspace (`arena-space-<id>`, idempotent
start/reuse, teardown at mission end), containment policy — `--network none`
by default (bounded internet is an explicit opt-in), 1g memory, 1 cpu, 256
pid limit, the workspace as the ONLY mount. Honesty contract: `auto` mode
isolates when a runtime exists and records the honest host-jail fallback in
the mission statusDetail when not; `container` mode fails loudly; every
isolated command's output carries a `[isolated:container · image · net]`
prefix so the journal always records WHICH environment executed it.
Agents are told their EXECUTION ENVIRONMENT in-context. UI: mission panel
Advanced controls (isolation mode + network). Live container runs require a
machine with Docker/Podman; lifecycle, containment, and fallback are fully
unit-tested with an injected runner (9 tests).

## Phase C — Browser automation (view real sites/videos, manage accounts) 🚧

Per-mission headless Chromium via Playwright, driven through the SAME
governance gate: navigation, extraction, screenshots are `browser.view`
(auto-executed, journaled); clicks, form fills, and anything that changes
state are `browser.interact` (approval-gated).

SHIPPED (`src/lib/spaces/browser.ts` + executeTool wiring): per-space
persistent profiles (`.data/space-workspaces/<id>/browser-profile` — one
space's cookies/logins are never visible to another), lazy playwright-core
engine, and five tools — `browser_navigate` / `browser_extract` /
`browser_screenshot` (view, auto) and `browser_click` / `browser_fill`
(interact, APPROVAL-GATED). The gating is enforced before the browser can
even launch — proven by test (engine events empty until the human decides).
Honesty contract: no Chromium → an actionable `npx playwright install
chromium` error, never a fabricated page. Live browsing requires the
Chromium binary on the machine; the tool surface, gating, and unavailability
paths are fully unit-tested with an injected engine (6 tests).

## Phase D — External action surfaces (calls, SMS, payments) 🚧

Real-world actions behind the strictest gates: telephony (voice + SMS) and
payment links are `external.call` / `external.sms` / `payment.link` — every
single instance requires an explicit human approval, executed through
provider integrations the owner configures and funds.

SHIPPED (`src/lib/spaces/external.ts` + executeTool wiring): Twilio voice
calls (spoken TwiML) and SMS (from number or messaging service), Stripe
payment links (real product → price → link REST chain; the URL pays into the
OWNER's account). No provider account is bundled and none is assumed —
unconfigured → honest, actionable messages naming the env vars. Safety:
E.164 validation, message sanitizing, a hard payment cap
(`MAX_PAYMENT_AMOUNT_USD`, default 250 — over-cap requests are refused
before any provider request), refused payments recorded as tool failures,
never silent successes. The approval payload carries the exact recipient,
words, and amount the human is deciding on; a denied request is terminal and
nothing is ever sent (all proven by test). Live sends require owner
credentials; payloads, validation, caps, gating, and unconfigured paths are
fully unit-tested with an injected fetcher (8 tests).
