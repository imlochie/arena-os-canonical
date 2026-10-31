import { parentPort, workerData } from "node:worker_threads";

import { demixMdx, type MdxModelSpec } from "@workspace/arena/lib/waveyard/separation/mdx";
import {
  loadOrtModule,
  sessionInfer,
  SeparationUnavailableError,
  executionProviderAttempts,
  WAVEYARD_ORT_EXECUTION_MODE,
  WAVEYARD_ORT_INTER_OP_THREADS,
  WAVEYARD_ORT_INTRA_OP_THREADS,
  verifyModelFile,
  type MdxSessionLike,
} from "@workspace/arena/lib/waveyard/separation/session";
import type { MdxStageTimings } from "@workspace/arena/lib/waveyard/separation/mdx";

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

  const attempts = executionProviderAttempts(request.requestedDevice);
  let session: MdxSessionLike | undefined;
  let resolvedDevice: string | undefined;
  let lastError: unknown = null;
  for (const executionProviders of attempts) {
    try {
      session = await ort.InferenceSession.create(modelPath, {
        executionProviders,
        // Keep inference bounded so it can share a machine with playback and
        // ordinary API work. The full JS demix pipeline also stays off-thread.
        intraOpNumThreads: WAVEYARD_ORT_INTRA_OP_THREADS,
        interOpNumThreads: WAVEYARD_ORT_INTER_OP_THREADS,
        executionMode: WAVEYARD_ORT_EXECUTION_MODE,
        // All model calls use fixed tensor dimensions. ONNX Runtime's arena
        // and memory pattern reuse buffers across chunks instead of allocating
        // them repeatedly.
        enableCpuMemArena: true,
        enableMemPattern: true,
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

  let response:
    | {
        separated: Awaited<ReturnType<typeof demixMdx>>;
        resolvedDevice: string;
        timings: MdxStageTimings | undefined;
      }
    | undefined;
  try {
    let timings: MdxStageTimings | undefined;
    const separated = await demixMdx(
      [new Float32Array(request.left), new Float32Array(request.right)],
      request.spec,
      sessionInfer(session, (type, data, dims) => new ort.Tensor(type, data, dims)),
      (done, total) => port.postMessage({ type: "progress", done, total }),
      (measured) => {
        timings = measured;
      },
    );
    response = { separated, resolvedDevice, timings };
  } finally {
    // Do not signal completion until the native session is released. The
    // parent runs recipe models sequentially and waits for this worker to
    // exit before opening the next session.
    await session.release();
  }
  if (response) {
    const transfers = [
      response.separated.primary[0].buffer,
      response.separated.primary[1].buffer,
      response.separated.secondary[0].buffer,
      response.separated.secondary[1].buffer,
    ];
    port.postMessage({ type: "result", ...response }, transfers);
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
