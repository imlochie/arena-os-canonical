import { parentPort, workerData } from "node:worker_threads";

import { demixMdx, type MdxModelSpec } from "@workspace/arena/lib/waveyard/separation/mdx";
import {
  loadOrtModule,
  sessionInfer,
  SeparationUnavailableError,
  verifyModelFile,
  type MdxSessionLike,
} from "@workspace/arena/lib/waveyard/separation/session";

type RequestData = {
  spec: MdxModelSpec;
  requestedDevice: "auto" | "cpu" | "cuda";
  left: ArrayBuffer;
  right: ArrayBuffer;
};

const port = parentPort;
if (port === null) throw new Error("Separation inference worker must run in a worker thread.");

async function run() {
  const request = workerData as RequestData;
  const modelPath = await verifyModelFile(request.spec);
  const ort = await loadOrtModule();
  if (!ort) {
    throw new SeparationUnavailableError(
      "onnxruntime-node is not available in this installation — the separation engine cannot run. " +
        "Reinstall the app; if it persists, this build is missing its inference runtime.",
    );
  }

  const attempts: string[][] = request.requestedDevice === "cuda" ? [["cuda"], ["cpu"]] : [["cpu"]];
  let session: MdxSessionLike | undefined;
  let resolvedDevice: string | undefined;
  let lastError: unknown = null;
  for (const executionProviders of attempts) {
    try {
      session = await ort.InferenceSession.create(modelPath, {
        executionProviders,
        // Keep inference bounded so it can share a machine with playback and
        // ordinary API work. The full JS demix pipeline also stays off-thread.
        intraOpNumThreads: 1,
        interOpNumThreads: 1,
        enableCpuMemArena: false,
        enableMemPattern: false,
      });
      resolvedDevice = executionProviders[0];
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!session || resolvedDevice === undefined) {
    throw new SeparationUnavailableError(
      `Could not open separation model "${request.spec.id}" for inference: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
    );
  }

  try {
    const separated = await demixMdx(
      [new Float32Array(request.left), new Float32Array(request.right)],
      request.spec,
      sessionInfer(session, (type, data, dims) => new ort.Tensor(type, data, dims)),
      (done, total) => port.postMessage({ type: "progress", done, total }),
    );
    const transfers = [
      separated.primary[0].buffer,
      separated.primary[1].buffer,
      separated.secondary[0].buffer,
      separated.secondary[1].buffer,
    ];
    port.postMessage({ type: "result", separated, resolvedDevice }, transfers);
  } finally {
    await session.release();
  }
}

void run()
  .catch((error: unknown) => {
    port.postMessage({
      type: "error",
      errorCode: error instanceof SeparationUnavailableError ? error.errorCode : null,
      message: error instanceof Error ? error.message : String(error),
    });
  })
  .finally(() => port.close());
