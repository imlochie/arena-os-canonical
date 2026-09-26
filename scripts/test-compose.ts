import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

function command(
  commandName: string,
  args: string[],
  inherit = true,
  env: NodeJS.ProcessEnv = process.env,
) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(commandName, args, {
      stdio: inherit ? "inherit" : "pipe",
      env,
    });
    child.once("error", (error) => reject(error));
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`${commandName} ${args.join(" ")} exited ${code}`)));
  });
}
async function waitForHealth() {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch("http://localhost:3000/api/health");
      if (response.ok && (await response.json()).ok === true) return;
    } catch { /* stack is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error("Compose web health gate did not pass within three minutes.");
}
async function main() {
  try { await command("docker", ["version"], false); } catch { throw new Error("Docker is required for real Compose verification and is not available."); }
  const keep = process.env.WAVEYARD_KEEP_COMPOSE === "1";
  const keepE2eContainer = process.env.WAVEYARD_KEEP_E2E_CONTAINER === "1";
  // This secret exists only for the lifetime of the Compose release gate. It
  // enables deterministic, authenticated fault injection without exposing a
  // control route in normal deployments.
  const composeEnv = {
    ...process.env,
    WAVEYARD_TEST_FAULT_TOKEN: randomBytes(32).toString("hex"),
    // The Phase 4 Compose test registers this address and verifies persisted
    // moderator-only decisions through the same HTTP boundary.
    WAVEYARD_INITIAL_MODERATOR_EMAILS: "moderator@waveyard.test",
  };
  try {
    await command("docker", ["compose", "up", "--build", "-d"], true, composeEnv);
    await waitForHealth();
    // `up --build` does not build profile-gated services. Build the E2E image
    // here so this gate can never run an older Playwright test suite.
    const e2eArgs = ["compose", "--profile", "test", "run", "--build"];
    if (keepE2eContainer)
      e2eArgs.push("--name", "waveyard-e2e-release-gate");
    else e2eArgs.push("--rm");
    e2eArgs.push("e2e");
    await command("docker", e2eArgs, true, composeEnv);
  } finally {
    if (!keep) await command("docker", ["compose", "down", "--volumes", "--remove-orphans"], true, composeEnv).catch(() => undefined);
  }
}
void main();
