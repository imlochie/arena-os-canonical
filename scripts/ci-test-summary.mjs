import { readFileSync } from "node:fs";
import { tapFailureAnnotations } from "./lib/ci-tap-summary.mjs";
try {
  const annotations = tapFailureAnnotations(readFileSync(process.argv[2], "utf8"));
  if (!annotations.length) console.log("::notice::No failing test identities found in TAP. The failure may be outside test execution; inspect the failed step.");
  for (const annotation of annotations) console.log(annotation);
} catch {
  console.log("::notice::TAP evidence unavailable: tests may not have started. Inspect dependency/service preparation and the failed step.");
}
