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
