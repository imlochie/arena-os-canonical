/** Workspace notes are untrusted claims, not a privileged path into host files.
 * Reuse the output path policy, then a bounded no-follow descriptor read.
 */
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { containedOutputPath } from "./mission-outputs";
export async function readMissionMemory(root: string): Promise<{ text: string; issue?: string }> {
  let file;
  try {
    const full = await containedOutputPath(root, "AGENT_NOTES.md");
    file = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await file.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > 65536) throw new Error("Unsafe notes");
    const bytes = Buffer.alloc(Math.min(6000, before.size));
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    const after = await file.stat();
    if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error("Notes changed");
    return { text: bytes.subarray(0, bytesRead).toString("utf8").slice(0, 1500) };
  } catch (e) {
    return { text: "", ...((e as NodeJS.ErrnoException).code === "ENOENT" ? {} : { issue: "Workspace notes not loaded: unsafe, oversized, unavailable or changed during read. They were not treated as verified memory." }) };
  } finally { await file?.close(); }
}
