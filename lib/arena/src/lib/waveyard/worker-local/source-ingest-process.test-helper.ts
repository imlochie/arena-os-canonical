import { stat } from "node:fs/promises";

import { pool } from "@workspace/db";
import { getStorage } from "../storage";
import { ingestSourceFile } from "../source-ingest";

const projectId = process.env.SOURCE_INGEST_TEST_PROJECT_ID;
const filePath = process.env.SOURCE_INGEST_TEST_FILE_PATH;

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
    send({ type: "stored", key });
    await waitForRelease();
  };

  try {
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
  } finally {
    await pool.end();
    process.disconnect?.();
  }
}

main().catch((error: unknown) => {
  send({ type: "error", message: error instanceof Error ? error.stack ?? error.message : String(error) });
  process.disconnect?.();
  process.exitCode = 1;
});
