import { stat } from "node:fs/promises";

import { db, pool } from "@workspace/db";
import { getStorage } from "../storage";
import { ingestSourceFile } from "../source-ingest";

const projectId = process.env.SOURCE_INGEST_TEST_PROJECT_ID;
const filePath = process.env.SOURCE_INGEST_TEST_FILE_PATH;
const failureMode = process.env.SOURCE_INGEST_TEST_FAILURE_MODE;
let uploadedKey: string | undefined;

if (failureMode === "after-commit" || failureMode === "before-commit") {
  const transaction = db.transaction.bind(db) as (...args: any[]) => Promise<unknown>;
  let injectedFailure = false;
  Object.defineProperty(db, "transaction", {
    configurable: true,
    value: (...args: any[]) => {
      const [callback, ...options] = args;
      if (!injectedFailure && failureMode === "after-commit") {
        injectedFailure = true;
        return transaction(callback, ...options).then(() => {
          throw new Error("SOURCE_INGEST_TEST_FORCED_FAILURE_AFTER_COMMIT");
        });
      }
      if (!injectedFailure && failureMode === "before-commit") {
        injectedFailure = true;
        return transaction(async (tx: unknown) => {
          await callback(tx);
          throw new Error("SOURCE_INGEST_TEST_FORCED_FAILURE_BEFORE_COMMIT");
        }, ...options);
      }
      return transaction(...args);
    },
  });
}

function send(message: Record<string, unknown>): void {
  process.send?.(message);
}

async function waitForRelease(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onMessage = (message: unknown) => {
      if (!message || typeof message !== "object" || (message as { type?: unknown }).type !== "release") return;
      process.off("message", onMessage);
      process.off("disconnect", onDisconnect);
      resolve();
    };
    const onDisconnect = () => {
      process.off("message", onMessage);
      reject(new Error("Parent disconnected before releasing the upload."));
    };
    process.on("message", onMessage);
    process.once("disconnect", onDisconnect);
  });
}

async function main(): Promise<void> {
  if (!projectId || !filePath) {
    throw new Error("Source-ingest process test configuration is incomplete.");
  }

  const storage = getStorage();
  const putFile = storage.putFile.bind(storage);
  storage.putFile = async (key, localPath, contentType) => {
    await putFile(key, localPath, contentType);
    uploadedKey = key;
    send({ type: "stored", key });
    if (!failureMode) await waitForRelease();
  };

  const file = await stat(filePath);
  const result = await ingestSourceFile({
    projectId,
    filePath,
    filename: "concurrent-upload.wav",
    mimeType: "audio/wav",
    model: "kim_vocal_2",
    device: "auto",
    provenance: { method: "local-upload" },
    prepareProcessing: false,
    probedAudio: {
      durationSeconds: 1,
      sampleRate: 44_100,
      channels: 2,
      codec: "pcm_s16le",
      bitrate: null,
      container: "wav",
      sizeBytes: file.size,
    },
  });
  send({ type: "done", sourceId: result.source.id, storageKey: result.source.storageKey });
  await pool.end();
  process.disconnect?.();
}

main().catch(async (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  await pool.end().catch(() => undefined);
  if (failureMode && message.startsWith("SOURCE_INGEST_TEST_FORCED_FAILURE_")) {
    send({ type: "failed", message, key: uploadedKey });
    process.exitCode = 0;
  } else {
    send({ type: "error", message: error instanceof Error ? error.stack ?? error.message : String(error) });
    process.exitCode = 1;
  }
  process.disconnect?.();
});
