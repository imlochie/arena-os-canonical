# Deploying the College

The phone cannot reach a laptop. This is what has to exist before
`COLLEGE_AUTH_MODE=strict` is doing anything useful.

Everything here is verified against the repo as it stands — the production
build succeeds, the migration runner is idempotent, and a fresh database
reaches exactly the same 78 tables as the working one.

---

## A. What the deployment actually needs

| Piece | Requirement |
|---|---|
| Node | 22.x |
| PostgreSQL | 16+ (18 locally; nothing version-specific is used) |
| `DATABASE_URL` | full connection string, SSL for managed providers |
| `COLLEGE_AUTH_MODE` | **`strict`** — non-negotiable once public |
| HTTPS | mandatory: device tokens travel in an `Authorization` header |
| Health check | `GET /api/health` |

---

## B. Migrations

`drizzle-kit push` is a development tool. It diffs a live database and applies
whatever it infers, with no record of what ran and no ordering guarantee — it
will drop a column it believes is redundant. It is not used in production.

```bash
npm run db:generate   # after changing src/db/*.ts — writes a .sql file
npm run migrate       # applies pending files in order, once each
```

`scripts/migrate.mjs` applies each file in a transaction and records it in
`_migrations`. A failure rolls back and exits non-zero.

**Baseline adoption.** A database that predates the runner has the tables but
no history, so the baseline would fail with *"relation already exists"*. Rather
than make the baseline destructive, or wrap everything in `IF NOT EXISTS` —
which would silently skip genuinely missing tables on a fresh deploy — the
runner detects that case and records the baseline as satisfied. Both paths are
verified:

```
existing database → · 0000_college_baseline.sql (adopted: 78 college tables already present)
fresh database    → ✓ 0000_college_baseline.sql (78 statements)
```

---

## C. Deploy

### Docker (any host)

```bash
docker build -t lochie-college .
docker run -d -p 3000:3000 \
  -e DATABASE_URL="postgresql://…" \
  -e COLLEGE_AUTH_MODE=strict \
  lochie-college
```

The image is multi-stage, runs as a non-root `college` user, and carries no
build toolchain. Run `npm run migrate` against the new database before the
first boot.

### Managed platforms

Any host that runs a Dockerfile or a Next.js standalone build works — Fly.io,
Railway and Render are all a reasonable fit for a single-student institution,
and all three can host the Postgres alongside it. **Vercel is a poor fit here**:
the College holds long-lived pooled database connections and its class runtime
is not shaped like a serverless function.

Whatever the host: set both environment variables, terminate TLS, and point a
domain at it.

---

## D. Backups

The event ledger is the institution's memory. Losing it loses the College's
account of itself, which no re-seed can reconstruct.

```bash
pg_dump "$DATABASE_URL" --no-owner --format=custom > college-$(date +%F).dump
```

Managed Postgres providers do this automatically — confirm the retention
window rather than assuming one. Restore should be rehearsed at least once
while it doesn't matter.

---

## E. The first deploy, in order

1. Provision Postgres, capture `DATABASE_URL`.
2. `DATABASE_URL=… npm run migrate`
3. Deploy with `COLLEGE_AUTH_MODE=strict`.
4. `curl https://your-domain/api/health` → expect `{"ok":true,"authMode":"strict"}`.
   **If it says `development`, the environment variable did not reach the
   process, and the College is open.**
5. Restore institutional state: `POST /api/college/bootstrap`, then
   `curriculum init` + `add_course`, `members from_preset` + `assign`,
   `timetable-live import_reference`. Bootstrap seeds canon only.
6. Open `/college/devices`, mint a Campus code, pair the phone.

---

## F. Health check

`GET /api/health` is deliberately shallow — it proves the process is up and
the database answers, nothing more. A health endpoint that runs business logic
becomes a way to trigger business logic from outside.

It is intentionally **unauthenticated**: monitoring cannot hold a device token.
It exposes no connection string and no institutional state. It does report
whether auth is `strict` or `development`, which is the single most useful
thing to see from outside after a deploy.

---

## G. The security posture, stated plainly

Before Layer 9 the API had no authentication: an unauthenticated
`POST /api/college/bootstrap` returned 201 and reseeded the institution.

After Layer 9:

- every College route requires a paired device token
- capability is derived from the **surface**, never stored per device
- the Campus surface cannot edit curriculum, timetable, faculty, or make
  institutional decisions — structurally, not by hiding buttons
- tokens are stored as SHA-256 hashes
- revocation takes effect on the next request

**The one remaining footgun is `COLLEGE_AUTH_MODE`.** Unset, loopback gets
Control Room authority with no token. That is correct for a laptop and
catastrophic in public, which is why `/api/health` reports it.
