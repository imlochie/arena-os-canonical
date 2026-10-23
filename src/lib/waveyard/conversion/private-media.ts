import { lstat } from "node:fs/promises";
import { join } from "node:path";
import type { StorageProvider } from "../storage";
/** Private-volume prerequisite; refuse existing symlink/hardlink aliases.
 * No arbitrary host path enters this boundary. Local administrator tampering
 * with the volume remains outside the single-owner runtime trust boundary.
 */
export async function assertPrivateMedia(storage: StorageProvider, key: string, allowMissing = false) {
  const root = storage.getLocalPath(".");
  if (!root || !key || key.split(/[\\/]/).some(p => !p || p === "." || p === "..")) throw new Error("Unsafe private media key.");
  let current = root;
  const parts = key.split("/");
  for (const [index, component] of ["", ...parts].entries()) {
    current = component ? join(current, component) : current;
    try {
      const details = await lstat(current);
      if (details.isSymbolicLink() || (index < parts.length ? !details.isDirectory() : !details.isFile() || details.nlink !== 1)) throw new Error("Private media contains an unsafe symlink/hardlink or non-file alias.");
    } catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}
