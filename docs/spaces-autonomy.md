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

## Phase B — Real workspace isolation (container/VM workspaces) 🚧

Per-mission workspaces graduate from host directories to real isolated
environments: Linux containers (Docker/Podman) where available, WSL2 on
Windows. The tool surface stays identical — `run_command` executes inside the
container; the host is unreachable by construction. Status: see
`src/lib/spaces/workspace-isolation.ts` (probe + isolated-run dispatch with
honest fallback to the host jail when no container runtime exists — the
mission journal always records WHICH environment executed every action).

## Phase C — Browser automation (view real sites/videos, manage accounts) 🚧

Per-mission headless Chromium via Playwright, driven through the SAME
governance gate: navigation, extraction, screenshots are `browser.view`
(auto-executed, journaled); clicks, form fills, and anything that changes
state are `browser.interact` (approval-gated). Status: see
`src/lib/spaces/browser.ts`.

## Phase D — External action surfaces (calls, SMS, payments) 🚧

Real-world actions behind the strictest gates: telephony (voice + SMS) and
payment links are `external.call` / `external.sms` / `payment.link` — every
single instance requires an explicit human approval, executed through
provider integrations the owner configures and funds. Status: see
`src/lib/spaces/external.ts`.
