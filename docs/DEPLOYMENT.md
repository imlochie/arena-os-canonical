# Deployment

`docker compose up --build` is the intended single-machine development deployment. It runs:

- Next.js web application
- separate Node worker with Python, FFmpeg, PyTorch and Demucs
- PostgreSQL
- Redis
- MinIO plus bucket setup
- database migration job

The supplied worker image is CPU-only. CUDA requires a separately maintained CUDA/PyTorch worker image and NVIDIA container runtime; setting `STEM_DEVICE=cuda` on the CPU image must fail, not fall back.

For production, replace all default credentials, set a long `SESSION_SECRET`, use TLS behind a reverse proxy, restrict database/Redis/MinIO networks, configure durable backups, and place an authenticated email/password-reset flow and rate limiter in service before inviting untrusted users. Public assets should use a dedicated publication policy and short-lived signed URLs where appropriate.

## Dormant capability surfaces (audited 2026-10)

Two capability families ship in code but are intentionally **not reachable in the
local-first product**. They are documented here so nobody mistakes them for live
features:

- **WebAuthn authentication** (`/api/identity/authentication/options|verify`): the full
  challenge/ceremony/session-cookie/rate-limit machinery exists, but there is no login
  UI — the local-first build resolves every request to the single local owner. Enabling
  hosted multi-user mode requires building the login surface and setting
  `COLLEGE_AUTH_MODE`-style upstream auth; until then these routes answer but nothing
  drives them.
- **The `/api/exports/*` family** (list/detail/media/retry): a parallel export API that
  predates the studio job pipeline. The visual studio UI drives `/api/studio/jobs/*`
  instead. Retained for compatibility; do not build against it for new surfaces.
- **The `/api/device-artifacts/*` family** (upload/download): gated on the
  `arena_session` cookie that only the WebAuthn ceremony issues — in the local-first
  build no session token is ever minted, so these routes always answer 403 locally.
  Hosted-mode surface; activates together with the login flow above.
- **The `/api/execution-sessions/{id}` inspector**: reads the `execution_sessions`
  layer (events/assignments/inputs/handoffs/worker executions) that only the hosted
  multi-user runtime creates — no local-first flow writes those rows, so the detail
  route has nothing to show locally.

All were surfaced by the full product audit (`docs/arena-product-audit.md`); the
archive finding-lineage route and the WanGP model-detail route are wired in the UI
(bridge page and visual studio respectively).
