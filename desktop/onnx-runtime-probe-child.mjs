import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { verifyOnnxRuntime } from "./onnx-runtime-probe.mjs";

const [stagedEntry, directory] = process.argv.slice(2);
const runtime = createRequire(stagedEntry)("onnxruntime-node");
assert.equal(typeof runtime.InferenceSession?.create, "function");
await verifyOnnxRuntime(runtime, directory);
