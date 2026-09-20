import { spawn } from "node:child_process";

function command(commandName: string, args: string[], inherit = true) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(commandName, args, { stdio: inherit ? "inherit" : "pipe" });
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
  try {
    await command("docker", ["compose", "up", "--build", "-d"]);
    await waitForHealth();
    await command("docker", ["compose", "--profile", "test", "run", "--rm", "e2e"]);
  } finally {
    if (!keep) await command("docker", ["compose", "down", "--volumes", "--remove-orphans"]).catch(() => undefined);
  }
}
void main();
