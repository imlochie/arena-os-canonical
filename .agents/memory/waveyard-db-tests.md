---
name: Waveyard database test runtime
description: Temporary PostgreSQL readiness and real-route identity constraints in Waveyard acceptance tests.
---

The Waveyard service integration suite starts a temporary PostgreSQL server. In this workspace, bundled embedded PostgreSQL binaries may be absent, so tests fall back to system Nix binaries. Those binaries can initialize a cluster but fail startup if PostgreSQL tries to create its default Unix socket under the missing `/run/postgresql` directory. Run TypeScript tests through the workspace `tsx` runner because direct Node execution can fail to resolve extensionless imports.

**Why:** Queue/session behavior relies on database foreign keys and cascades. A browser fixture or successful typecheck does not validate those semantics, and a readiness failure happens before those assertions run.

**How to apply:** Run tests with `pnpm --filter @workspace/scripts exec tsx --test <test-file>`. If PostgreSQL startup fails, inspect the child process output. When tests connect only over TCP, launch PostgreSQL with `unix_socket_directories=` to avoid dependence on `/run/postgresql`, then run the database integration suite before interpreting a startup failure as an application regression.

For acceptance that crosses from library service calls into real UI-facing routes, seed records for the API's actual identity rather than assuming an arbitrary service-test owner is interchangeable.

**Why:** A successful intake under a synthetic owner produced an empty real library response. Project-detail checks did not expose the mismatch because local project-role handling and owner-filtered library listing have different boundaries.

**How to apply:** Resolve the route's identity when creating acceptance records, keep the database disposable, and verify the returned library data before interpreting missing UI entries as a worker or frontend failure.

When a test forks a TypeScript worker process from Node's test runner, pass only the TypeScript loader arguments to the child and disconnect its IPC channel when the work ends.

**Why:** Inheriting the test runner's full `process.execArgv` makes the worker launch another test harness; an open IPC channel can also keep a finished child alive.

**How to apply:** Filter inherited arguments to the `tsx` loader and close IPC after completion, while keeping intentionally held worker processes connected until the test releases or terminates them.

For browser persistence checks against real Waveyard route handlers, use a disposable PostgreSQL database and import database modules only after setting `DATABASE_URL`. From the scripts workspace, resolve the DB source modules relatively when runtime alias resolution is unavailable; let browser API calls invoke the real handlers and inspect committed rows directly.

**Why:** The database pool captures its connection URL at module load, and a mocked route can make browser state look correct while the database remains stale.

**How to apply:** Start PostgreSQL in a temporary directory, migrate it, set test-mode identity and storage paths, then dynamically import the DB and route handlers before driving the UI. Close all pools and remove the fixture directory afterward.

When a Waveyard test crosses a child-process boundary, PGlite state is not shared, and the process-wide storage singleton can point at another concurrently running fixture.

**Why:** A child cannot see in-memory database state, while parallel tests can replace environment paths after the parent has already cached its storage provider.

**How to apply:** Use disposable local PostgreSQL, configure a shared temporary storage directory for the child, and inject an explicit provider into parent-side handlers and assertions.
