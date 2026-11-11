// Node's --test treats the router's literal [id] segment as a glob pattern.
// Import the route acceptance file from a plain path so tsx executes its real
// database-backed node:test case instead of reporting a misleading zero tests.
await import("../artifacts/api-server/src/imported/waveyard/projects/[id]/mashup/route.test.ts");
