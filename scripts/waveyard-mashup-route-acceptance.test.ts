// Node's --test treats the route's literal [id] path segment as a glob.
// Import through a normal-name entry point so the database-backed API test
// executes instead of returning a misleading TAP report with zero tests.
await import("../artifacts/api-server/src/imported/waveyard/projects/[id]/mashup/route.test.ts");
