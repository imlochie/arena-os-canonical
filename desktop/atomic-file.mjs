import { open, rename, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

// Original Node implementation informed by storytold/craft-libs' craft-atomic
// design: private same-directory staging, flush before commit, bounded Windows
// lock retries, and never unlink the previous destination to force a rename.
// Callers still own path/link checks and concurrency. This does not promise
// directory fsync, Apple F_FULLFSYNC, or power-loss survival on every filesystem.
export async function writeSyncedAtomic(target, content, {
  platform = process.platform,
  renameFile = rename,
  wait = sleep,
} = {}) {
  if (!path.isAbsolute(target)) throw new TypeError("Atomic destinations must be absolute.");
  const temporary = `${target}.${randomUUID()}.tmp`;
  let created = false;
  let committed = false;
  try {
    const file = await open(temporary, "wx", 0o600);
    created = true;
    try {
      await file.writeFile(content);
      await file.sync();
    } finally {
      await file.close();
    }
    const delays = [10, 30, 90];
    for (let attempt = 0; ; attempt++) {
      try {
        await renameFile(temporary, target);
        committed = true;
        return;
      } catch (error) {
        if (platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(error.code) || attempt >= delays.length)
          throw error;
        await wait(delays[attempt]);
      }
    }
  } finally {
    if (created && !committed) {
      // Keep the original failure if an antivirus also locks the staging file.
      await rm(temporary, { force: true }).catch(error => {
        console.warn("Atomic staging cleanup failed:", error.code);
      });
    }
  }
}
