import { spawn } from "node:child_process";
import { getPool } from "@waveyard/database";
import { getQueueConnection } from "@waveyard/queue";
import { getStorage } from "@waveyard/storage";

async function command(name: string, args: string[]) {
  return new Promise<{ ok: boolean; detail: string }>((resolve) => {
    const child = spawn(name, args, { stdio: ["ignore", "pipe", "pipe"] }); let stdout = ""; let stderr = "";
    child.stdout.on("data", (value) => { stdout += String(value); }); child.stderr.on("data", (value) => { stderr += String(value); });
    child.once("error", (error) => resolve({ ok: false, detail: error.message })); child.once("close", (code) => resolve({ ok: code === 0, detail: (stdout || stderr).trim().split("\n")[0] || `exit ${code}` }));
  });
}
async function check(name: string, action: () => Promise<{ ok: boolean; detail: string }>) { const outcome = await action().catch((error) => ({ ok:false, detail:error instanceof Error ? error.message : String(error) })); console.log(`${outcome.ok ? "PASS" : "FAIL"} ${name}: ${outcome.detail}`); return outcome.ok; }
async function main() {
  const python = process.env.PYTHON_BIN ?? "python3";
  const results = await Promise.all([
    check("Python", () => command(python, ["--version"])),
    check("FFmpeg", () => command("ffmpeg", ["-version"])),
    check("PyTorch + CUDA", () => command(python, ["-c", "import torch; print(f'torch={torch.__version__} cuda={torch.cuda.is_available()}')"])),
    check("Demucs", () => command(python, ["-m", "demucs", "--help"])),
    check("PostgreSQL", async () => { await getPool().query("select 1"); return { ok:true, detail:"connected" }; }),
    check("Redis", async () => { const redis = getQueueConnection(); const pong = await redis.ping(); return { ok:pong === "PONG", detail:pong }; }),
    check("Storage", async () => { const storage = getStorage(); await storage.healthcheck(); return { ok:true, detail:storage.kind }; }),
  ]);
  if (results.some((ok) => !ok)) process.exitCode = 1;
}
void main();
