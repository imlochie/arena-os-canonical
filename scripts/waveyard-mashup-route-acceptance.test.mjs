import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Node's test runner interprets the literal [id] route segment as a glob when
// the route.test.ts file is passed directly, and can report zero tests.
// Import it through this path-safe entry point so its registered test executes.
const workspaceRoot = fileURLToPath(new URL("../", import.meta.url));
const routeTest = resolve(
  workspaceRoot,
  "artifacts/api-server/src/imported/waveyard/projects/[id]/mashup/route.test.ts",
);
await import(pathToFileURL(routeTest).href);
