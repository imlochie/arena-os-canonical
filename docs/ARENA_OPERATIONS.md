# Arena operations

## First setup

```bash
cp .env.example .env.local
# Set DATABASE_URL in .env.local
npm install
npm run db:migrate
npm run dev
```

Arena's database-backed routes require `DATABASE_URL`. The application does not
silently create or migrate a production database. Run migrations explicitly
before starting a deployment.

## Verification

```bash
npm run typecheck
npm run lint
npm run build
```

The nested `luma/` Expo project has its own toolchain and checks. The root
TypeScript project intentionally excludes it; run LUMA checks from `luma/`.

## Failure semantics

A database outage is an operational error, not an empty dataset. API consumers
should distinguish unavailable storage from a successful empty response before
this is used with personal or institutional records.
