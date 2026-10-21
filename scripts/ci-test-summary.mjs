import { readFileSync } from "node:fs";
import { installFailureAnnotation } from "./lib/ci-install-summary.mjs";
import { tapFailureAnnotations } from "./lib/ci-tap-summary.mjs";
try {
  const text = readFileSync(process.argv[2], "utf8");
  if (process.argv.includes("--install")) {
    const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
    const packages = Object.keys(lock.packages ?? {}).filter(key => key.includes("node_modules/")).map(key => key.split("node_modules/").at(-1));
    console.log(installFailureAnnotation(text, packages));
  } else {
  const annotations = tapFailureAnnotations(text);
  if (!annotations.length) console.log("::notice::No failing test identities found in TAP. The failure may be outside test execution; inspect the failed step.");
  for (const annotation of annotations) console.log(annotation);
  if (process.argv.includes("--details")) {
    // Bounded raw assertion context for remote diagnostics when the signed
    // artifact host is unreachable. Test exit codes remain authoritative.
    const first = text.indexOf("not ok");
    const details = first < 0 ? text.slice(-8000) : text.slice(first, first + 12000);
    const chunks = details.match(/[\s\S]{1,2800}/g) ?? [];
    const escape = value => value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
    for (const [index, chunk] of chunks.entries()) console.log(`::notice title=Retained TAP assertion ${index + 1}/${chunks.length}::${escape(chunk)}`);
  }
  }
} catch {
  if (process.argv.includes("--install")) console.log("::notice::Dependency preparation diagnostic unavailable. No product acceptance receipt is established.");
  else console.log("::notice::TAP evidence unavailable: tests may not have started. Inspect dependency/service preparation and the failed step.");
}
