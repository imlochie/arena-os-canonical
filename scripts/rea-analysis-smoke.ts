import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeImportedHtmlGame } from "../artifacts/api-server/src/imported/arcade/rea-analysis";

async function main() {
  const scratch = await mkdtemp(join(tmpdir(), "arena-rea-smoke-"));
  const executionSentinel = join(scratch, "target-code-was-executed");
  try {
    const html = `<!doctype html><html><body><canvas></canvas><script>
      require("node:fs").writeFileSync(${JSON.stringify(executionSentinel)}, "unexpected");
      let score = 0;
      function loop() { requestAnimationFrame(loop); }
      addEventListener("keydown", event => { if (event.key === "ArrowRight") score += 1; });
      localStorage.setItem("score", String(score));
      loop();
    </script></body></html>`;
    const analysis = await analyzeImportedHtmlGame(html);
    assert.equal(analysis.scriptsFound, 1);
    assert.equal(analysis.scriptsParsed, 1);
    assert.equal(analysis.parseFailures, 0);
    assert(analysis.functionNames.includes("loop"));
    assert(analysis.inputEvents.includes("keydown"));
    assert(analysis.gameLoopApis.includes("requestAnimationFrame"));
    assert(analysis.progressStores.includes("localStorage"));
    await assert.rejects(access(executionSentinel));
    await assert.rejects(
      analyzeImportedHtmlGame('<!doctype html><html><head><script src="https://example.invalid/game.js"></script></head><body></body></html>'),
      /external resource/i,
    );
    console.log("REA static analysis passed: game signals were found without executing source or accepting remote scripts.");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
