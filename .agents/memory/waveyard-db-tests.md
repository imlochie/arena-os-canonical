---
name: Waveyard database test runtime
description: Runtime constraints for the Waveyard library's temporary PostgreSQL integration suite.
---

The Waveyard service integration suite starts a temporary PostgreSQL server. In this workspace, bundled embedded PostgreSQL binaries may be absent, so tests fall back to system Nix binaries. Those binaries can initialize a cluster but fail startup if PostgreSQL tries to create its default Unix socket under the missing `/run/postgresql` directory. Run TypeScript tests through the workspace `tsx` runner because direct Node execution can fail to resolve extensionless imports.

**Why:** Queue/session behavior relies on database foreign keys and cascades. A browser fixture or successful typecheck does not validate those semantics, and a readiness failure happens before those assertions run.

**How to apply:** Run tests with `pnpm --filter @workspace/scripts exec tsx --test <test-file>`. If PostgreSQL startup fails, inspect the child process output. When tests connect only over TCP, launch PostgreSQL with `unix_socket_directories=` to avoid dependence on `/run/postgresql`, then run the database integration suite before interpreting a startup failure as an application regression.
