import { rmSync } from "node:fs";

// Keep the existing pnpm-only policy without requiring a POSIX shell on Windows.
if (!process.env.npm_config_user_agent?.startsWith("pnpm/")) {
  console.error("Use pnpm instead");
  process.exitCode = 1;
} else {
  for (const file of ["package-lock.json", "yarn.lock"]) rmSync(file, { force: true });
}
