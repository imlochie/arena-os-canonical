---
name: Waveyard database test runtime
description: Runtime constraints for the Waveyard library's temporary PostgreSQL integration suite.
---

The Waveyard service integration suite starts a temporary PostgreSQL server. In this workspace, the bundled embedded PostgreSQL binaries were absent; falling back to the system Nix binaries initialized a cluster, but the server never passed readiness. Running the TypeScript test directly also requires extensionless-import resolution.

**Why:** Queue/session behavior relies on database foreign keys and cascades. A browser fixture or successful typecheck does not validate those semantics, and a readiness failure happens before those assertions run.

**How to apply:** If this suite fails at startup, inspect the child PostgreSQL process output and fix the test runtime before interpreting it as an application regression. Run the database integration suite when the temporary server can start.
