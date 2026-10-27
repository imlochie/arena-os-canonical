/**
 * Auto-provision .env for local runs. Wired as `predev` / `prebuild` /
 * `prestart` so a fresh clone works without hand-creating files:
 *
 *   npm install && npm run dev        ← .env appears automatically
 *
 * Never overwrites an existing .env (it may hold real provider keys);
 * only creates the file from .env.example when it is absent.
 */
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const envPath = join(root, ".env");
const examplePath = join(root, ".env.example");

if (!existsSync(envPath)) {
  if (existsSync(examplePath)) {
    copyFileSync(examplePath, envPath);
    console.log(
      "[env] No .env found — created one from .env.example with local defaults.",
    );
    console.log(
      "[env] If your local PostgreSQL differs (password/port), edit .env now. See README.",
    );
  } else {
    console.warn(
      "[env] No .env and no .env.example — set DATABASE_URL before database features work.",
    );
  }
} else {
  const current = readFileSync(envPath, "utf8");
  if (!/^\s*DATABASE_URL\s*=/m.test(current)) {
    console.warn(
      "[env] .env exists but has no DATABASE_URL line — add one (see .env.example).",
    );
  }
}
