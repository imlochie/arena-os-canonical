---
name: PostgreSQL test binaries
description: Database integration test setup across workspaces with bundled or system PostgreSQL.
---

Database-backed tests may run where embedded PostgreSQL packages are absent but `initdb`, `postgres`, and `pg_ctl` are available on `PATH`. Test fixtures should resolve bundled binaries first, then use the system tools, and skip only when neither option is available.

**Why:** A route regression was initially skipped because its fixture checked only for a bundled package even though the workspace had working PostgreSQL binaries.

**How to apply:** For temporary PostgreSQL integration fixtures, resolve the complete binary set before skipping and always stop the server and close the application pool during cleanup.
