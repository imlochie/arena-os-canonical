# Development

## Requirements

- Node.js 22+
- npm 10+
- PostgreSQL 16+
- Redis 7+
- FFmpeg/FFprobe
- Python 3.11+ with PyTorch and Demucs for worker/proof commands
- Docker + Compose for the documented local stack

## Local process layout

```bash
npm ci
cp .env.example .env.local
npm run db:migrate
npm run dev
npm run worker
```

`npm run worker:doctor` checks actual Python, FFmpeg, PyTorch, Demucs, database, Redis and storage availability. `npm run prove:demucs` does not have a mock mode.

## Tests

```bash
npm run typecheck
npm run lint
npm test
STEM_DEVICE=cpu npm run prove:demucs
```

The CPU proof requires local model dependencies and may be slow. CUDA verification is a distinct check on actual NVIDIA hardware: if unavailable, report `GPU TEST: NOT RUN`.
