import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rm } from "node:fs/promises";
import path from "node:path";
import yauzl from "yauzl";
import { safePackagePath, validateReleaseUrl } from "./packages.mjs";
import { fetchWithTransientRetries } from "./retry-fetch.mjs";

export async function sha256File(filename, signal) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename, { highWaterMark: 64 * 1024, signal })) hash.update(chunk);
  return hash.digest("hex");
}
export async function downloadPinnedZip(pin, filename, signal, progress = () => {}) {
  try { if (await sha256File(filename, signal) === pin.sha256) return; } catch (error) { if (error.code !== "ENOENT") throw error; }
  await rm(filename, { force: true });
  const partial = `${filename}.partial`;
  await rm(partial, { force: true });
  const output = await open(partial, "wx");
  let response;
  try {
    let url = validateReleaseUrl(pin.url);
    for (let redirects = 0; redirects < 5; redirects++) {
      response = await fetchWithTransientRetries(url, { signal, redirect: "manual", headers: { "Accept-Encoding": "identity" } });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      await response.body?.cancel();
      url = validateReleaseUrl(new URL(response.headers.get("location") ?? "", url).href);
    }
    if (!response?.ok || !response.body || (response.headers.has("content-length") && Number(response.headers.get("content-length")) !== pin.bytes)) throw new Error("Pinned ZIP download failed or its publisher size changed.");
    const hash = createHash("sha256"); let bytes = 0;
    for await (const chunk of response.body) {
      signal.throwIfAborted(); bytes += chunk.length;
      if (bytes > pin.bytes) throw new Error("ZIP download exceeded its pinned byte budget.");
      hash.update(chunk); await output.writeFile(chunk); progress(bytes, pin.bytes);
    }
    signal.throwIfAborted();
    if (bytes !== pin.bytes || hash.digest("hex") !== pin.sha256) throw new Error("Publisher ZIP digest mismatch; nothing will be installed.");
    await output.sync(); await output.close();
    const { rename } = await import("node:fs/promises");
    await rename(partial, filename);
  } catch (error) {
    await output.close().catch(() => {}); await rm(partial, { force: true }); throw error;
  } finally { if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {}); }
}
/** Selected files only, regular entries only, one stream at a time. The full
 * archive must have its reviewed publisher digest verified BEFORE extraction. */
export async function extractSelectedZip(filename, destination, select, signal, { maxFiles = 18000, maxBytes = 1400 * 1024 * 1024 } = {}) {
  await mkdir(destination, { recursive: true });
  const zip = await new Promise((resolve, reject) => yauzl.open(filename, { lazyEntries: true, autoClose: false, strictFileNames: true, validateEntrySizes: true },
    (error, value) => error ? reject(error) : resolve(value)));
  let entries = 0, files = 0, total = 0;
  const seen = new Set();
  try {
    await new Promise((resolve, reject) => {
      const fail = error => { signal.removeEventListener("abort", abort); zip.close(); reject(error); };
      const abort = () => fail(signal.reason ?? new Error("ZIP extraction cancelled."));
      signal.addEventListener("abort", abort, { once: true });
      zip.once("error", fail);
      zip.once("end", () => { signal.removeEventListener("abort", abort); resolve(); });
      zip.on("entry", entry => {
        (async () => {
          signal.throwIfAborted();
          if (++entries > 40000) throw new Error("ZIP directory exceeds its entry budget.");
          const name = entry.fileName;
          const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
          if (entry.generalPurposeBitFlag & 1 || (mode && ![0x8000, 0x4000].includes(mode))) throw new Error("Encrypted, linked or special ZIP entries are not supported.");
          if (name.endsWith("/")) { zip.readEntry(); return; }
          // Validate original names too, even when the selection omits them.
          safePackagePath(name);
          const relative = select(name);
          if (relative === null) { zip.readEntry(); return; }
          safePackagePath(relative);
          if (++files > maxFiles || seen.has(relative.toLowerCase()) || !Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0 ||
              (total += entry.uncompressedSize) > maxBytes) throw new Error("ZIP output is duplicate or exceeds its file/byte budget.");
          seen.add(relative.toLowerCase());
          const target = path.join(destination, ...relative.split("/"));
          await mkdir(path.dirname(target), { recursive: true });
          const output = await open(target, "wx");
          const input = await new Promise((resolveStream, rejectStream) => zip.openReadStream(entry, (error, stream) => error ? rejectStream(error) : resolveStream(stream)))
            .catch(async error => { await output.close(); throw error; });
          let copied = 0;
          const abortStream = () => input.destroy(signal.reason ?? new Error("ZIP extraction cancelled."));
          signal.addEventListener("abort", abortStream, { once: true });
          try {
            for await (const chunk of input) {
              signal.throwIfAborted(); copied += chunk.length;
              if (copied > entry.uncompressedSize) throw new Error("ZIP entry exceeded its declared size.");
              await output.writeFile(chunk);
            }
            if (copied !== entry.uncompressedSize) throw new Error("ZIP entry was truncated.");
          } finally { signal.removeEventListener("abort", abortStream); input.destroy(); await output.close(); }
          zip.readEntry();
        })().catch(fail);
      });
      zip.readEntry();
    });
  } finally { zip.close(); }
  signal.throwIfAborted();
  if (!files) throw new Error("No expected files were found in the pinned ZIP.");
  return { files, bytes: total };
}
