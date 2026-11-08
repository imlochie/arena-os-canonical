/** Workspace notes are untrusted claims, not a privileged path into host files.
 * Ported from PR #21: reject symlinked paths and hard-linked or oversized
 * files, read through a no-follow descriptor, and discard the read if the file
 * changed underneath it. */
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";

const NOTES_FILE = "AGENT_NOTES.md";
const MAX_NOTES_FILE_BYTES = 65536;
const MAX_NOTES_READ_BYTES = 6000;
export const MAX_MEMORY_CHARS = 1500;

export const MEMORY_ISSUE =
  "Workspace notes not loaded: unsafe, oversized, unavailable or changed during read. They were not treated as verified memory.";

async function containedNotesPath(root: string): Promise<string> {
  const resolvedRoot = path.resolve(root);
  const full = path.join(resolvedRoot, NOTES_FILE);
  for (const part of [resolvedRoot, full]) {
    if ((await lstat(part)).isSymbolicLink()) throw new Error("Symlink notes are not authorised.");
  }
  return full;
}

export async function readMissionMemory(root: string): Promise<{ text: string; issue?: string }> {
  let file;
  try {
    const full = await containedNotesPath(root);
    file = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await file.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > MAX_NOTES_FILE_BYTES) throw new Error("Unsafe notes");
    const bytes = Buffer.alloc(Math.min(MAX_NOTES_READ_BYTES, before.size));
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    const after = await file.stat();
    if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error("Notes changed");
    }
    return { text: bytes.subarray(0, bytesRead).toString("utf8").slice(0, MAX_MEMORY_CHARS) };
  } catch (e) {
    return { text: "", ...((e as NodeJS.ErrnoException).code === "ENOENT" ? {} : { issue: MEMORY_ISSUE }) };
  } finally {
    await file?.close();
  }
}
