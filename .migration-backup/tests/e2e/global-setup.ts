import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

export default function globalSetup() {
  execFileSync(process.env.PYTHON_BIN ?? "python3", [resolve(process.cwd(), "scripts/create_audio_fixture.py")], { stdio: "inherit" });
}
