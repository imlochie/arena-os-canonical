// Optional evaluation through the application's existing configured local-model
// runtime. No credentials, URLs or arbitrary provider errors are printed.
import { mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { forgeGameWithAI, ForgeDraftError } from "../src/lib/games/forge-ai.ts";
import { validateGameRuntime } from "../src/lib/games/runtime-validation.ts";
const root = `.data/arcade-live-eval/${Date.now()}`;
await mkdir(root, { recursive: true });
const receipt = { kind: "optional-live-local-provider", commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), worktreeClean: !execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim(), configured: Boolean(process.env.ARENA_ARCADE_EVAL_MODEL), endpointExplicitlyConfigured: Boolean(process.env.TURBOAGENT_URL), scope: "Existing local-model routing only; declared scenario observations, not independent arbitrary prompt fidelity or subjective game quality", status: "blocked", cases: [] };
if (receipt.configured) {
  for (const [id, prompt] of [
    ["maze", "Build a maze game: navigate around solid walls, collect a key, reach a locked exit, and restart."],
    ["shooter", "Build a shooter: aim horizontally, fire moving projectiles, hit enemies to score, win the wave and restart."],
    ["puzzle", "Build a switch puzzle: toggle two connected lights, score progress, solve the combination and restart."],
  ]) {
    let sequence = 0;
    try {
      const result = await forgeGameWithAI(prompt, {
        modelId: process.env.ARENA_ARCADE_EVAL_MODEL,
        localOnly: true,
        validateRuntime: code => validateGameRuntime(code, { requireGameplay: true }),
        onDraft: async draft => {
          const name = `${id}-draft-${String(++sequence).padStart(3, "0")}`;
          await writeFile(`${root}/${name}.html`, draft.code);
          await writeFile(`${root}/${name}.json`, JSON.stringify({ codeSha256: createHash("sha256").update(draft.code).digest("hex"), runtime: draft.runtime, report: draft.runtimeValidation }, null, 2));
        },
      });
      receipt.cases.push({ id, status: "passed-declared-scenarios", runtime: result.runtime, report: result.runtimeValidation, repairsUsed: result.repairsUsed });
      await writeFile(`${root}/${id}.html`, result.code);
    } catch (error) {
      receipt.cases.push({ id, status: error?.noModel ? "blocked" : "failed", reason: error?.noModel ? "Configured runtime did not provide a capable model" : "Generation/verification failed", report: error instanceof ForgeDraftError ? error.draft.runtimeValidation : undefined });
    }
  }
  receipt.status = receipt.cases.every(c => c.status === "passed-declared-scenarios") ? "passed-declared-scenarios" : "not-passed";
}
await writeFile(`${root}/receipt.json`, JSON.stringify(receipt, null, 2));
console.log(JSON.stringify({ status: receipt.status, configured: receipt.configured, cases: receipt.cases.map(c => ({ id: c.id, status: c.status })) }));
process.exitCode = receipt.status === "passed-declared-scenarios" ? 0 : receipt.status === "blocked" ? 2 : 1;
