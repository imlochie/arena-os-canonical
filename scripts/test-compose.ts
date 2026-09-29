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
  const keepE2eContainer = process.env.WAVEYARD_KEEP_E2E_CONTAINER === "1";
  // A named E2E container is useful only while its Compose dependencies and
  // Playwright artifacts remain available, so either diagnostic keep flag
  // suppresses teardown.
  const keep = process.env.WAVEYARD_KEEP_COMPOSE === "1" || keepE2eContainer;
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
  let e2eStarted = false;
  try {
    // Build every service, including the profile-gated E2E image, exactly once.
    // `compose run --build` would rebuild the worker's large local ML image after
    // the stack is healthy, delaying the actual Playwright gate by tens of minutes.
    await command("docker", ["compose", "--profile", "test", "build"], true, composeEnv);
    await command("docker", ["compose", "up", "-d"], true, composeEnv);
    await waitForHealth();
    // The images above are already current for this invocation. Never ask run
    // to rebuild them: this must start the test container, not a second bake.
    const e2eArgs = ["compose", "--profile", "test", "run"];
    if (keepE2eContainer) {
      // A retained diagnostic run deliberately uses a discoverable name so its
      // artifacts can be copied after failure. Replace only the prior
      // diagnostic container with that exact name; never touch project data,
      // volumes, or unrelated containers.
      await command("docker", ["container", "rm", "-f", "waveyard-e2e-release-gate"], true, composeEnv)
        .catch(() => undefined);
      e2eArgs.push("--name", "waveyard-e2e-release-gate");
    } else e2eArgs.push("--rm");
    e2eArgs.push("e2e");
    e2eStarted = true;
    await command("docker", e2eArgs, true, composeEnv);
  } catch (error) {
    if (e2eStarted) {
      console.error("=== WEB LOG TAIL BEGIN ===");
      await command("docker", ["compose", "logs", "--no-color", "--tail", "300", "web"], true, composeEnv)
        .catch(() => undefined);
      console.error("=== WEB LOG TAIL END ===");
      console.error("=== WORKER LOG TAIL BEGIN ===");
      await command("docker", ["compose", "logs", "--no-color", "--tail", "300", "worker"], true, composeEnv)
        .catch(() => undefined);
      console.error("=== WORKER LOG TAIL END ===");
    }
    throw error;
  } finally {
    if (!keep) await command("docker", ["compose", "down", "--volumes", "--remove-orphans"], true, composeEnv).catch(() => undefined);
  }
}
void main();
