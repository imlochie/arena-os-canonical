# Spaces Autonomy Roadmap — genuine workspaces, strict check-ins

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
probe (docker → podman → wsl, real version output, never assumed), one
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
