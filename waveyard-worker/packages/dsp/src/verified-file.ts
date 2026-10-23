/** Shared server-side file verification; no registry or renderer code.
 * Verify exact bytes before rendering inputs, certifying outputs or serving media.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
export class PublishedFileError extends Error {
  readonly status: number;
  constructor(message: string, status = 422) {
    super(message);
    this.status = status;
  }
}
export async function verifyFileIdentity(
  filename: string,
  expected: { checksumSha256: string; fileSizeBytes: number },
  label = "Published output",
) {
  try {
    if (
      !/^[a-f0-9]{64}$/.test(expected.checksumSha256) ||
      !Number.isSafeInteger(expected.fileSizeBytes) ||
      expected.fileSizeBytes < 1
    )
      throw new PublishedFileError(
        `${label} has invalid checksum/size metadata.`,
      );
    const before = await stat(filename);
    if (!before.isFile() || before.size !== expected.fileSizeBytes)
      throw new PublishedFileError(
        `${label} checksum/size mismatch. Restore private storage; no corrupt bytes were certified.`,
      );
    let size = 0;
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(filename)) {
      size += chunk.length;
      if (size > expected.fileSizeBytes)
        throw new PublishedFileError(
          `${label} changed during verification.`,
        );
      hash.update(chunk);
    }
    const after = await stat(filename);
    if (
      size !== expected.fileSizeBytes ||
      hash.digest("hex") !== expected.checksumSha256 ||
      before.ino !== after.ino ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new PublishedFileError(
        `${label} checksum changed; no corrupt bytes were certified.`,
      );
  } catch (error) {
    if (error instanceof PublishedFileError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new PublishedFileError(
        `${label} is missing. Restore private storage; an existing metadata row is not a completed file.`,
        410,
      );
    throw new PublishedFileError(
      `${label} storage unavailable; verification was not acknowledged.`,
      503,
    );
  }
}
export async function verifyStoredFile(
  storage: {
    getLocalPath(key: string): string | null;
    getToFile(key: string, filename: string): Promise<void>;
  },
  asset: { storageKey: string; checksumSha256: string; fileSizeBytes: number },
) {
  let local: string | null;
  try { local = storage.getLocalPath(asset.storageKey); }
  catch { throw new PublishedFileError("Published output storage unavailable; verification was not acknowledged.", 503); }
  if (local) return verifyFileIdentity(local, asset);
  const temporary = await mkdtemp(join(tmpdir(), "arena-publication-verify-"));
  try {
    const filename = join(temporary, "output");
    await storage.getToFile(asset.storageKey, filename);
    await verifyFileIdentity(filename, asset);
  } catch (error) {
    if (error instanceof PublishedFileError) throw error;
    throw new PublishedFileError(
      "Published output storage unavailable; verification was not acknowledged.",
      503,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
