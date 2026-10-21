/** Test executable only: controlled PCM inference, real executor/PG/storage/kill. */
import { db, pool } from "../../src/db";
import { handleSeparationJob } from "../../src/lib/waveyard/worker-local/separation";
import { reconcileSeparation, reconcileNativeSeparations } from "../../src/lib/waveyard/separation/recovery";
import { runDeepSeparation } from "../../src/lib/waveyard/separation/deep";
import { getStorage } from "../../src/lib/waveyard/storage";
import { readFile, writeFile, mkdir, appendFile } from "node:fs/promises";
import { dirname } from "node:path";
import { decodeSourceToStereoPcm } from "../../src/lib/waveyard/measure/pcm";
import { checksumFile } from "../../src/lib/waveyard/audio";
const input = JSON.parse(process.env.CRASH_INPUT!);
async function boundary(phase: string) {
  process.send?.({ phase });
  if (phase === process.env.CRASH_PHASE) await new Promise(() => {});
}
if (process.env.CRASH_PHASE === "object-partial") {
  const storage = getStorage();
  storage.putFile = async (key, file) => {
    const data = await readFile(file), destination = storage.getLocalPath(key)!;
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, data.subarray(0, data.length / 2));
    await boundary("object-partial");
    await appendFile(destination, data.subarray(data.length / 2));
  };
}
if (process.env.CRASH_CORRUPT_WRITE === "1") {
  const storage = getStorage(), put = storage.putFile.bind(storage);
  storage.putFile = async (key, file, type) => { await put(key, file, type); const destination = storage.getLocalPath(key)!; const bytes = await readFile(destination); bytes[bytes.length - 1] ^= 1; await writeFile(destination, bytes); };
}
if (process.env.CRASH_LOST_ACK === "1") {
  const transaction = db.transaction.bind(db);
  db.transaction = (async (...args: Parameters<typeof db.transaction>) => { const result = await transaction(...args); if (result === "recovered-bank") throw new Error("controlled lost recovery COMMIT acknowledgement"); return result; }) as typeof db.transaction;
}
try {
  if (process.env.CRASH_MODE === "recover") {
    const result = await reconcileSeparation(db, input.processingJobId, boundary);
    process.send?.({ result });
  } else if (process.env.CRASH_MODE === "startup") {
    const results = await reconcileNativeSeparations(db, async job => { process.send?.({ queued: job.id }); });
    process.send?.({ results });
  } else await handleSeparationJob(input, { db, boundary, decode: process.env.CRASH_DECODER_BIN ? (path, hint, _deps, options) => decodeSourceToStereoPcm(path, hint, { resolveFfmpeg: async () => process.env.CRASH_DECODER_BIN! }, { ...options, onSpawn: async pid => { process.send?.({ nativePid: pid }); await options?.onSpawn?.(pid); } }) : undefined, runDeep: async request => {
    if (["1", "real"].includes(process.env.CRASH_NATIVE ?? "")) return runDeepSeparation({ ...request,
      onSpawn: async pid => { process.send?.({ nativePid: pid }); await request.onSpawn?.(pid); },
      onProgress: percent => { request.onProgress?.(percent); if (percent > 0) process.send?.({ phase: "inference-running" }); },
    }, process.env.CRASH_NATIVE === "real" ? {} : { verifyCheckpoint: checksumFile }); // Deliberate dummy-checkpoint CLI seam, never real-model proof.
    await boundary("inference-running");
    return { engine: "demucs", model: "deep_4s", modelName: "CONTROLLED", modelVersion: "CONTROLLED-NOT-INFERENCE", checkpointPath: "NO-WEIGHTS", resolvedDevice: "cpu", stems: ["vocals", "drums", "bass", "other"].map(stemType => ({ stemType: stemType as "vocals", path: request.inputPath, bytes: 44 + 44100 * 4 })) };
  } });
} catch (error) { process.send?.({ error: error instanceof Error ? error.message : String(error) }); process.exitCode = 1; }
finally { await pool.end(); }
