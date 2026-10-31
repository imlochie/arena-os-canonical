import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { access, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { copyExternalPackage, pruneOnnxRuntimeForWindowsX64 } from "./build.mjs";
import { verifyOnnxRuntime } from "./onnx-runtime-probe.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
const apiRequire = createRequire(path.join(root, "artifacts/api-server/package.json"));

test("stages ONNX Runtime with CPU inference and Windows DirectML dependencies", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "arena-ort-stage-"));
  const nodeModules = path.join(temporaryRoot, "server", "node_modules");
  try {
    await copyExternalPackage("onnxruntime-node", apiRequire, nodeModules);
    const stagedRequire = createRequire(path.join(temporaryRoot, "server", "index.mjs"));
    const runtime = stagedRequire("onnxruntime-node");
    assert.equal(typeof runtime.InferenceSession?.create, "function");
    const runtimeRequire = createRequire(stagedRequire.resolve("onnxruntime-node"));
    assert.ok(runtimeRequire.resolve("onnxruntime-common"));
    const windowsRuntime = path.join(nodeModules, "onnxruntime-node", "bin", "napi-v6", "win32", "x64");
    for (const file of ["onnxruntime.dll", "DirectML.dll", "dxcompiler.dll", "dxil.dll"]) {
      await access(path.join(windowsRuntime, file));
    }
    await verifyOnnxRuntime(runtime, temporaryRoot);
    await pruneOnnxRuntimeForWindowsX64(path.join(nodeModules, "onnxruntime-node"));
    const napiRoot = path.join(nodeModules, "onnxruntime-node", "bin", "napi-v6");
    assert.deepEqual(
      (await readdir(napiRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name),
      ["win32"],
    );
    assert.deepEqual(
      (await readdir(path.join(napiRoot, "win32"), { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name),
      ["x64"],
    );
    for (const file of ["onnxruntime_binding.node", "onnxruntime.dll", "DirectML.dll", "dxcompiler.dll", "dxil.dll"]) {
      await access(path.join(napiRoot, "win32", "x64", file));
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
