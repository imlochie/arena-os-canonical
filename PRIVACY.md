# Privacy and Data Handling

## Privacy position

Privacy is a system behavior, not an interface promise. The canonical Arena must make it clear where inference happens, which provider is used, what is stored, how it is retrieved, and how it is deleted. A “local” badge without enforced routing is not Local Mode.

## Current legacy behavior: accurate but limited

The preserved application contains these useful privacy-oriented mechanisms:

- browser-local `localMode` and `ephemeral` preferences;
- server handling that attempts to avoid cloud requests when `localOnly` is present;
- metadata-only `privacy_events` rows;
- export and wipe endpoints; and
- a browser WebLLM experiment for Arcade Forge.

It also has material limitations:

- privacy flags are supplied by the client/request rather than an authenticated, server-enforced policy;
- there is no user identity, ownership, collaboration access control, or project isolation;
- the application can call Pollinations, OpenRouter, Groq, and Pollinations Image services in cloud mode;
- `localTextReply` and procedural image fallbacks are not actual local model inference;
- current wipe/export paths do not cover all later-added project/cognitive-session data consistently;
- privacy event reads are global, not user scoped; and
- browser localStorage BYOK handling is a legacy convenience, not a canonical credential-management design.

Do not interpret the legacy app's “local”, “offline”, “never trained on”, or “ephemeral” UI as a verified multi-user privacy guarantee.

## Canonical execution environments

Every response/job records one environment and displays it to the user:

| Environment | Meaning | Egress rule |
| --- | --- | --- |
| `browser-local` | Inference runs in a browser-hosted runtime such as WebLLM | Prompt/files remain in browser unless a separately selected tool or save action sends them to Arena. |
| `local` | Worker calls a user/self-hosted local endpoint such as Ollama | No cloud inference, cloud embedding, cloud moderation, or cloud upload for that job. Local network endpoint is disclosed. |
| `cloud` | Worker calls a selected provider connection | Provider, model, and relevant data use are displayed before/during execution. |
| `hybrid` | A user-approved workflow has distinct local and cloud steps | Each step records environment/provider; hidden fallback is prohibited. |

Local-only policy is evaluated server-side before a job is queued. A job requesting a missing local capability fails with an actionable `local_provider_unavailable` state; it does not silently fall back to cloud or a deterministic template.

## Data inventory: canonical target

| Data category | Typical storage | Scope | User controls |
| --- | --- | --- | --- |
| Account/session | relational DB | user | view profile, revoke sessions, delete account |
| Project metadata | relational DB | project membership | view/edit/delete/export by role |
| Conversations/responses | relational DB | project or private conversation | inspect, archive, delete, export |
| Artifacts/versions | relational DB + optional blob storage | project | edit, restore, duplicate, delete, export |
| Files and extracted chunks | object storage + relational metadata | project | upload, preview, delete, download, export |
| Memory and memory sources | relational DB | global/project/session/agent | view, edit, delete, export; scope visibly labelled |
| Provider connection secrets | encrypted secret store/reference | owner only | create, rotate, revoke, delete |
| Job/tool metadata | relational DB/events | project/user | inspect safe summaries, cancel where allowed |
| Privacy events | relational DB, metadata only | user/project | inspect and export |
| Export bundles | object storage, time-limited | requesting user/project | download, delete, expiry displayed |

Prompt/response content must not be copied into privacy events or general operational logs by default. Diagnostics should use IDs, redacted summaries, timing, status, and provider/model metadata.

## Memory policy

Memory is not an invisible prompt cache. Each entry declares:

```text
scope: global | project | session | agent
classification: fact | claim | interpretation | proposal | decision | open_question | preference
source: object link(s) or explicit user entry
confidence: explicit value or unknown
created / updated / author
```

Retrieval is scope-filtered before ranking. No project can retrieve another project's files, messages, artifacts, or memory. Users can inspect, correct, delete, and export entries.

## Privacy events

Canonical event examples include:

```text
file.uploaded
file.deleted
memory.created
memory.deleted
inference.local_used
inference.cloud_used
provider.connection_deleted
project.export_requested
project.export_completed
project.deletion_requested
project.deletion_completed
account.deletion_requested
```

Events identify the actor, project/object IDs, action, environment/provider where applicable, timestamp, and result. They avoid sensitive payloads. Event retention and backup interaction must be published before release.

## Export and deletion

Export includes projects, conversations, Arena/Battle/Council records, artifacts and versions, memories and sources, decisions, tasks, activity metadata, and permitted files/metadata. It preserves source/provenance relationships.

Deletion is a durable worker operation, not a UI hide. It:

1. records an authorized deletion request;
2. removes or cascades relational objects according to a documented policy;
3. removes associated blobs and search/index records;
4. invalidates relevant export/download links and provider credentials;
5. records completion without retaining deleted content in the event; and
6. explains any backup retention window honestly.

## Provider and credential policy

- The platform never trains a model on user data itself.
- Third-party provider terms and retention policies vary; the UI must link/describe the selected provider's current policy rather than making a universal claim.
- User/provider credentials must not be stored in browser localStorage in the canonical product.
- Cloud use requires a selected provider connection and visible model/environment metadata.
- Local endpoint URLs and credentials are treated as sensitive configuration.

## Privacy acceptance tests

- With cloud providers disabled, project creation, chat, Arena, Battle, Council, and artifact creation work against a supported local provider—or each unavailable capability is clearly explained.
- A local-only job produces no cloud provider, cloud embedding, cloud moderation, or cloud storage call.
- User A cannot list/read/delete User B's project, memory, file, artifact, conversation, response, or export.
- Deleting an object removes it from retrieval and export according to the retention policy.
- Privacy event view/export is scoped to the authorized user/project.
