# Owner and Device Identity

Arena uses WebAuthn/passkeys as its owner-authentication direction. It stores credential identifiers, public keys, counters, and authenticator metadata; private authenticator material is never stored.

Production requires `ARENA_WEBAUTHN_RP_ID` and an HTTPS `ARENA_WEBAUTHN_ORIGIN`. Startup/configuration fails rather than downgrading when either is absent or the origin is not HTTPS.

Local development defaults explicitly to RP ID `localhost` and origin `http://localhost:3000`. First-owner bootstrap is an internal/local service operation and additionally requires `ARENA_LOCAL_IDENTITY_BOOTSTRAP=1`; it is always rejected when `NODE_ENV=production`. There is no unauthenticated enrollment route and no Tool Effect approval endpoint in this slice.

Authenticated sessions use random bearer material whose SHA-256 hash alone is persisted. Identity is derived server-side from that session and its credential/device relationships. Device capability grants are exact capability/resource/scope/effect tuples. High-risk authorization requires a fresh WebAuthn verification timestamp.

The laptop execution node has its own device record, credential relationship, and optional public node key. Remote node dispatch is intentionally deferred.
