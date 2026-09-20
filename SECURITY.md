# Security Policy

## Current security posture

**The preserved legacy application is not approved for public or multi-user deployment.** Its general routes still have no authentication or server-side authorization model, and its broad migration/security coverage remains incomplete. Stem Lab adds a bounded private-media session/membership layer and unexecuted Compose isolation checks, but that does not turn the legacy application into a general production security guarantee.

High-priority reconstruction items are documented in [REBUILD.md](./REBUILD.md) and the intended controls in [ARCHITECTURE.md](./ARCHITECTURE.md).

## Reporting a vulnerability

Until a project-owned security contact is configured, do not disclose unverified vulnerabilities in public issues. Contact the repository owner privately through the repository's private security reporting channel (if enabled) or their established private contact method. Include:

- affected version/commit and deployment context;
- reproducible steps or a minimal proof of concept;
- impact and data/access assumptions;
- suggested remediation if known; and
- a safe contact channel for follow-up.

Please do not access, alter, delete, or exfiltrate data that is not yours. Allow reasonable time for acknowledgement and remediation before public disclosure.

## Canonical security requirements

### Identity and authorization

- Secure registration, login, logout, reset, account deletion, and revocable sessions.
- HttpOnly, Secure, SameSite cookie/session policy appropriate to deployment topology.
- Every project/resource action checks authenticated ownership or `ProjectMembership` server-side.
- Database identifiers are never authorization tokens.
- Invitations and membership changes are owner-controlled and audited.

### API and web application

- Schema validation and size limits for every request.
- CSRF mitigation for cookie-authenticated state-changing requests.
- Rate limiting by actor/IP/provider-sensitive endpoint.
- Safe errors that do not leak stack traces, credentials, prompts, or other users' object existence.
- Content Security Policy, clickjacking/referrer controls, and secure transport headers.
- Cursor pagination and scope filters before data retrieval.

### Files, tools, and execution

- Authenticated uploads with size/type limits, generated object keys, malware/content processing policy, and private object storage.
- Explicit per-agent tool grants; tools receive only scoped project context.
- Tool executions are visible as safe summaries and auditable.
- Generated code never executes on the web/worker host. Any code execution requires an isolated sandbox, resource limits, timeout, filesystem isolation, and network policy.
- Agents cannot publish, spend money, change permissions, delete protected data, or access unrelated data without explicit human approval and an authorization check.

### Providers and secrets

- Credentials are loaded from server-side secret configuration or encrypted owner-scoped records; never bundled to the browser or committed.
- Provider/model routing is explicit, capability checked, and records local/cloud environment.
- Local-only policy prohibits cloud fallback and related cloud embedding/moderation/upload paths.
- Log redaction prevents secret/prompt/response payload leakage in general logs.

### Database and operations

- Versioned migrations with tested backup/restore.
- Least-privilege database, object-store, and queue accounts.
- Dependency updates and vulnerability triage before releases.
- Worker jobs are idempotent, cancellable, and authorized at creation and execution time.
- Audit/privacy event records are metadata-only and access controlled.

## Release blockers

A canonical release cannot be labelled secure until it has:

1. passing authentication/authorization integration tests including cross-user access denial;
2. validated input, session, CSRF, rate-limit, and security-header behavior;
3. file/tool sandbox security controls where those capabilities are enabled;
4. a documented local/cloud egress test;
5. resolved or accepted-with-documentation dependency advisories;
6. a migration, backup, deletion, and export test path; and
7. an owner-configured private vulnerability reporting channel.
