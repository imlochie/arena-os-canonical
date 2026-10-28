import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { copyExternalPackage } from "./build.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
const apiRequire = createRequire(path.join(root, "artifacts/api-server/package.json"));

test("stages ONNX Runtime with its native binding and runtime dependencies", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "arena-ort-stage-"));
  const nodeModules = path.join(temporaryRoot, "server", "node_modules");
  try {
    await copyExternalPackage("onnxruntime-node", apiRequire, nodeModules);
    const stagedRequire = createRequire(path.join(temporaryRoot, "server", "index.mjs"));
    const runtime = stagedRequire("onnxruntime-node");
    assert.equal(typeof runtime.InferenceSession?.create, "function");
    const runtimeRequire = createRequire(stagedRequire.resolve("onnxruntime-node"));
    assert.ok(runtimeRequire.resolve("onnxruntime-common"));
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
