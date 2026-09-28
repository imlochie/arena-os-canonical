import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { validateAudio } from "@waveyard/audio";

function run(command: string, args: string[]) {
  return new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolvePromise() : reject(new Error(`${command} exited ${code}`)));
  });
}

async function main() {
  const root = process.cwd();
  const fixture = resolve(root, "tests/fixtures/copyright-safe-fixture.wav");
  const output = await mkdtemp(join(tmpdir(), "waveyard-prove-demucs-"));
  const device = process.env.STEM_DEVICE ?? "cpu";
  try {
    await run(process.env.PYTHON_BIN ?? "python3", [resolve(root, "scripts/create_audio_fixture.py")]);
    await run(process.env.PYTHON_BIN ?? "python3", [resolve(root, "services/separation/separate.py"), "--input", fixture, "--output", output, "--model", process.env.SEPARATION_MODEL ?? "htdemucs", "--device", device]);
    for (const stem of ["vocals", "drums", "bass", "other"]) {
      const metadata = await validateAudio(join(output, `${stem}.wav`));
      console.log(`VALID ${stem}.wav ${metadata.durationSeconds}s ${metadata.sampleRate}Hz ${metadata.channels}ch`);
    }
    console.log(`REAL DEMUCS VERIFIED (${device}).`);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
}
void main();
