# Model Hub — download & connect AI models app-wide

`/model-hub` is the one place to get AI brains into the app. Four sections,
four honest paths. Nothing here pretends: every model that appears anywhere in
the app (chat, battles, council, collab) carries its real backend and
provenance (`via:`) on every response.

## 1. Local runtimes (self-contained download + connect)

Works with the three common local servers, auto-detected on the standard ports:

| Runtime | Port | Detection |
| --- | --- | --- |
| Ollama | 11434 | `/api/tags` answers |
| LM Studio | 1234 | `/v1/models` answers |
| llama.cpp server | 8080 | `/v1/models` answers |

- **Connect**: the hub scans those ports (`GET /api/model-hub` → discovered
  list) or you type a base URL manually. A connect re-probes the server and
  stores the connection row (`model_hub_connections`).
- **Register**: registering a model writes a binding
  (`model_hub_bindings`) and exposes the model app-wide with id
  `hub:<kind>:<slug>`, level `on-device`, backend `local-server`. Every picker
  that reads `/api/models` now offers it. Unregister removes it.
- **Execution**: the model's routing id is self-contained
  (`__server__:<encoded baseUrl>:<encoded model>`) — `generate()` needs no DB
  hit, and **loopback is re-asserted at execution time** so a tampered row
  cannot aim the server at a public host (SSRF guard).
- **Loopback policy**: `127.0.0.1` / `localhost` / `::1` always allowed;
  LAN addresses (10.x, 192.168.x, 172.16–31.x) only with
  `MODEL_HUB_ALLOW_LAN=1`; public hosts always refused.

## 2. Downloads (Ollama pull, streamed progress)

The hub page embeds a curated catalog (`PULL_CATALOG` in
`src/lib/modelHub/runtimes.ts`: TinyLlama → Mistral 7B, with honest size/RAM
labels). `POST /api/model-hub/pull` streams Ollama's NDJSON pull events
through to the page — real progress, cancellable. The catalog is a convenience
list; any tag Ollama serves can be pulled by typing it.

> Sandbox note: `registry.ollama.ai` is network-blocked in the dev sandbox, so
> real pulls are verified owner-side. The pull pipeline itself (streaming,
> parsing, progress rendering) is covered by unit tests with a local
> OpenAI-compatible test-double server.

## 3. Agent bridge — "back-wire an agent into the app"

`arena-agent` (model id `arena-agent`, backend `agent-bridge`) routes app
prompts to a real agent — a human at a terminal, or an AI agent session —
through a durable local queue:

- The app enqueues a task (`agent_bridge_tasks`) and waits up to 90 s.
- A bridge process polls `GET /api/agent-bridge` (which heartbeats
  `agent_bridge_state`; stale after 15 s), takes the next task, and posts the
  answer to `POST /api/agent-bridge/{id}`.
- No bridge connected → **fast-fail null** and a clearly labelled Local Engine
  fallback. Nothing hangs, nothing fakes.

```bash
node scripts/agent-bridge.mjs                 # interactive terminal loop
node scripts/agent-bridge.mjs --command "…" --once   # scripted one-shot
```

Optional auth: set `ARENA_INTERNAL_API_KEY` and pass `--key` (sent as
`x-arena-internal-key`). Answers are labelled honestly: *"Answered by a
connected agent — not a language model."*

## 4. Cloud & keys (including the ChatGPT-subscription question)

- **Free, keyless, works right now**: the default Pollinations tier (remote).
  No account, no key.
- **Free-tier BYOK**: OpenRouter and Groq keys (`KeysBar`, stored in browser
  localStorage only, sent per-request, never persisted server-side).
- **OpenAI BYOK**: an OpenAI API key field is provided
  (`openai:gpt-4o-mini`). Plain truth: **a ChatGPT Plus/Team subscription is
  not API access** — ChatGPT (the product) and the OpenAI platform (the API)
  bill separately. To use OpenAI models in the app you need pay-as-you-go
  platform credits; the key field is here for when you have them.

## Data model

- `model_hub_connections` — runtime servers you've connected (kind, base URL,
  label, last-seen).
- `model_hub_bindings` — registered models (cascades away with their
  connection).
- `agent_bridge_tasks` / `agent_bridge_state` — the bridge queue + heartbeat.

Migration: `desktop-migrations/0009_model_hub.sql` (applied by
`scripts/db-setup.mjs` / drizzle push).

## Verification

- Unit: `src/lib/modelHub/runtimes.test.ts` (loopback guard, routing-id
  round-trip, probe classification vs. test-double servers, pull-line parser),
  `src/lib/modelHub/agentBridge.test.ts` (fast-fail, full DB round-trip,
  no-op complete), `src/lib/modelHub/aiHub.test.ts` (generate() routes to a
  local OpenAI-compat test-double; SSRF re-assert; agent-bridge labeling and
  honest fallback).
- Live (sandbox): connect → register → generate against a clearly-labelled
  local OpenAI-compatible test-double server; bridge round-trip via
  `--once --command`.
- Owner-side (network-blocked in sandbox): real Ollama install + pull;
  real Pollinations/OpenRouter/Groq/OpenAI inference.
