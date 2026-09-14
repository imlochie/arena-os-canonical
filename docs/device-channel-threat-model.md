# Arena Device Channel Threat Model

## Assets and boundaries
Owner credentials, authenticated sessions, capability grants, Arena artifacts, Tool Effects, node identities, and local project data cross three boundaries: control device → Arena control plane → execution node. The network is always hostile; network location grants no trust.

## Threats and controls
| Threat | Primary controls | Residual/recovery |
|---|---|---|
| Stolen phone | passkey user verification, short/idle sessions, exact grants, fresh auth | revoke device and sessions |
| Stolen cookie | hashed server token, expiry/idle checks, dangerous capability grants | revoke session; audit |
| CSRF/compromised browser | SameSite cookie deployment requirement, same-origin mutation checks, no URL tokens | revoke session/device |
| Malicious worker | cannot create identity, grants, approval, paths, or node envelopes | inspect audit trail |
| Compromised adapter | bounded schemas, exact capability/scope, no shell | revoke capability/disable adapter |
| Malicious upload | 10 MiB limit, media allowlist, no client path, opaque storage identity, no extraction, nosniff download | reject/delete artifact |
| Artifact substitution | SHA-256 content identity and owner checks | mark unavailable and audit |
| Replay | unique nonce, 60-second envelope, atomic single consumption | reject and audit |
| Compromised network | production HTTPS/WebAuthn; signed node envelopes | rotate keys/revoke sessions |
| Compromised provider | no provider participates in device channel | revoke provider separately |
| Compromised node | independent node identity and narrow protocol; no shell/filesystem API | revoke/disable node |
| Storage exhaustion | upload size limit; quota remains required before public deployment | disable upload, purge artifacts |

## Hard invariants
Remote connectivity never increases session authority. Clients address artifact and node identities, never filesystem paths. The phone is a control surface, not a shell. Node requests are capability-specific, signed, expiring, digest-bound, and single-use. Uploaded archives are never automatically extracted.

## Implemented hardening
Node responses are signed, digest-bound, expiring, key-versioned, and atomically single-use. Node keys support bounded rotation overlap and revocation invalidates pending requests. Artifact payloads use AES-256-GCM encrypted local blob storage with per-artifact nonces and authentication tags; plaintext is absent from new relational records. Authentication, transfer, and node-request rate buckets are server-side and atomically bounded.

## Deferred risks
Malware scanning, aggregate persistent storage quotas, external key management/escrow, backup restoration ceremonies, authenticated node transport deployment, and production reverse-proxy cookie/TLS configuration must be completed before internet exposure.
