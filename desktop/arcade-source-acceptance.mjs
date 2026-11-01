// Final Windows pass only. This script is not run by Linux checks.
// Original MIT fixtures, not claims of importing a public game repository.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { ArcadePackages } from "./arcade/packages.mjs";
import { NativeArcadeHost } from "./arcade/host.mjs";
import { RepositoryBuilds } from "./arcade/repository-builds.mjs";
const here = path.dirname(fileURLToPath(import.meta.url));
const option = name => process.argv[process.argv.indexOf(name) + 1];
if (process.platform !== "win32" || process.arch !== "x64") throw new Error("Requires actual Windows x64. No simulated or Linux pass is recorded.");
if (!process.argv.includes("--allow-sdk-downloads") || !process.argv.includes("--helper") || !process.argv.includes("--root") || !process.stdin.isTTY) throw new Error("Run interactively: node desktop/arcade-source-acceptance.mjs --helper <built-native-helper.exe> --root <empty-managed-test-folder> --allow-sdk-downloads. SDK download/unpack may need several GiB; no global tools are installed.");
const root = path.resolve(option("--root")), helper = path.resolve(option("--helper"));
await access(helper); await mkdir(root, { recursive: true });
const packages = new ArcadePackages({ root, catalog: [] });
const host = new NativeArcadeHost({ packages, helper });
const builds = new RepositoryBuilds({ packages, host });
await builds.initialize(); await packages.initialize(); await host.initialize();
const input = createInterface({ input: process.stdin, output: process.stdout });
const report = { platform: "windows-x64", fixtureSource: "Original local MIT acceptance fixtures, not public repository imports",
  automatedGameplayVerified: false, fixtures: [], complete: false };
const reportPath = path.join(root, "source-acceptance-report.json");
const fixtureLicense = await readFile(path.join(here, "native", "source-fixtures", "LICENSE.txt"), "utf8");
try {
  await host.probe();
  for (const kind of ["sdl", "godot"]) {
    const directory = path.join(here, "native", "source-fixtures", kind);
    const files = [];
    for (const name of (await readdir(directory)).sort()) {
      const bytes = await readFile(path.join(directory, name));
      files.push({ path: name, size: bytes.length, sha: createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"), contentBase64: bytes.toString("base64") });
    }
    const revision = createHash("sha1").update(JSON.stringify(files)).digest("hex");
    const snapshot = { projectType: kind, folder: "", files, provenance: { repository: `local-fixtures/source-${kind}`, revision,
      sourceUrl: `arena-fixture://original-mit/source-${kind}`, license: { spdx: "MIT", path: "LICENSE.txt", text: fixtureLicense } } };
    console.log(`Building ${kind}; SDKs remain local and on-demand. This can take several minutes.`);
    const key = await builds.build(snapshot, new AbortController());
    await packages.verify(key);
    const fixture = { kind, key, sourceFingerprint: revision, compilerOrPackExportSucceeded: true,
      manualFirstLaunch: false, manualSaveRestoration: false, observedAudio: false };
    report.fixtures.push(fixture);
    for (const round of [1, 2]) {
      await host.launch(key);
      const run = [...host.runs.values()].find(run => run.child);
      assert.ok(run, "A real owned native game process must be running");
      const prompt = round === 1
        ? "In the native game: confirm a visible green square, press Right and see score/position change, and hear the quiet tone. Type YES only if all three work: "
        : "On relaunch, confirm the prior visible score/position were restored and Right still works. Type YES only if restored: ";
      const answer = await input.question(prompt);
      assert.equal(answer.trim().toUpperCase(), "YES", "Manual native observation failed; no gameplay pass recorded");
      if (round === 1) { fixture.manualFirstLaunch = true; fixture.observedAudio = true; }
      else fixture.manualSaveRestoration = true;
      await host.stop(run.id);
    }
    const cached = await builds.build(snapshot, new AbortController());
    assert.equal(cached, key, "Identical pinned inputs must reuse the immutable installed build");
    fixture.cacheReuseVerified = true;
  }
  report.containment = host.proof;
  report.complete = true;
} catch (error) {
  report.error = error.message;
  throw error;
} finally {
  input.close(); await builds.shutdown(); await host.shutdown();
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(`Report: ${reportPath}. Manual observations are explicitly separate from automated build/containment checks.`);
}
