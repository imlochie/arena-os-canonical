# Archive Assistant — an agent that understands, browses and uses the platform

`/archive` is a chat agent with **tools** — not another chat window. It knows
what modules exist in this workspace, can read their state, and can drive them:
list your spaces, projects and congress sessions; create and force-run a space;
convene a congress; save artifacts. It also owns the **archive index**: a
searchable catalog of your files that gets described, tagged and deduplicated
by AI.

```
you: "what modules do I have"        → list_modules
you: "list my spaces"                → list_spaces
you: "search archive for beethoven"  → archive_search
you: "convene a congress on pricing" → convene_congress
you: "run my lead sweeper now"       → run_space
```

## The tool registry (the plugin layer)

`src/lib/assistantTools.ts` is the plugin system. Every capability is one
entry:

```ts
{
  name: "archive_search",
  description: "Search the archive index…",   // goes into the system prompt
  parameters: { q: { type: "string", … } },   // JSON-ish spec
  run: (args, ctx) => listArchiveItems(…),    // calls library code directly
}
```

Adding a capability to the assistant = appending one entry that calls existing
library functions (no HTTP hop). Current tools:

| Group | Tools |
| --- | --- |
| Browse | `list_modules`, `list_projects`, `list_artifacts`, `list_spaces`, `list_congress_sessions` |
| Drive Spaces | `create_space` (template or custom), `run_space`, `set_space_status` |
| Deliberate | `convene_congress` |
| Archive | `archive_add`, `archive_scan`, `archive_search`, `archive_item`, `archive_update`, `archive_stats` |
| Write back | `save_artifact` |

House rules inherited by every tool: tools **describe and draft, never act
outward** (no posting, sending, buying); destructive operations are limited to
soft, reversible state changes.

## The agent loop

`POST /api/archive/chat` `{messages, modelId?, keys?, localOnly?}` →
`{reply, via, steps[]}`.

The model replies either with a fenced JSON tool call
(``` {"tool": "…", "args": {…}} ```) or with plain text (the final answer).
The server executes tool calls against the registry, feeds results back as
`TOOL RESULT` messages, and loops — max 4 tool calls / 6 steps per turn. Tool
activity is returned as `steps[]` and rendered as expandable 🔧 chips under
each reply.

**Local Mode:** with no keys or network, `generate()` returns fallback text
that can't drive the loop — so a deterministic router takes over for the
browse/search/stats intents (`help`, `list my spaces`, `search archive for …`,
`scan the inbox`). The assistant is genuinely usable with zero setup and
upgrades itself to full reasoning the moment a key exists.

## The archive index

The archive **references** files (name / path / size / hash) — it never moves
or modifies them. Pipeline:

1. **Register** — `archive_add` or the ➕ Add panel (one per line:
   `name | kind | size | path`). Kind is guessed from the extension; exact
   duplicates (content hash, or name+size) are skipped at insert.
2. **Scan** — `archive_scan` / the 🔍 Scan button: the model writes a
   one-sentence description, 3–6 tags, and a collection per file; near-dupes
   (≥75% name-similarity against indexed items, same kind) get flagged
   `possibleDupOf` for the human to confirm. Local mode marks items indexed
   with a placeholder description instead of inventing metadata.
3. **Search / edit** — full-text search across name/description/tags/
   collections; every card's description, tags, collection and status is
   editable inline (AI metadata is a draft, not a verdict).

### API

| Method & path | Body / query | Notes |
| --- | --- | --- |
| `POST /api/archive/chat` | `{messages, modelId?, keys?, localOnly?}` | one agent turn → `{reply, via, steps[]}` |
| `GET /api/archive/items` | `?q=&kind=&status=&collection=&limit=` | `{items, stats}` |
| `POST /api/archive/items` | `{files: [{name, kind?, sizeBytes?, path?, contentHash?, collection?}]}` | 201 `{added, duplicates}` |
| `PATCH /api/archive/items` | `{id, description?, tags?, collection?, status?, kind?}` | edit one item |
| `POST /api/archive/scan` | `{keys?, localOnly?, limit?}` | scan up to 20 inbox items |

Storage: `archive_items` table (migration `0013`) with the usual in-memory
fallback.

## Files

- `src/lib/assistantTools.ts` — the tool registry + module manifest (the
  plugin layer)
- `src/lib/archiveAssistant.ts` — the agent loop + local deterministic router
- `src/lib/archive.ts` — archive index store (add/dedupe/search/scan/stats)
- `src/app/api/archive/**` — chat, items, scan routes
- `src/components/ArchiveAssistant.tsx` — chat + index panel UI

## Design notes

- Tool calls go through the same `generate()` fan-out as everything else
  (BYOK, Local Mode, no-train headers), so the assistant uses whichever
  provider you've configured — including your own GPU via TurboAgent.
- The loop is request-scoped: no agent state persists between turns beyond the
  chat history the client sends. The archive index is the assistant's only
  durable memory.
- Why a JSON-in-markdown protocol instead of provider-native function calling:
  it works identically across every provider in the fan-out (Pollinations,
  OpenRouter, Groq, TurboAgent), including ones without function-calling APIs.
