import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";

function varint(value) {
  const bytes = [];
  let remaining = value;
  while (remaining > 0x7f) {
    bytes.push((remaining & 0x7f) | 0x80);
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(remaining);
  return bytes;
}

function tag(field, wire) {
  return varint((field << 3) | wire);
}

function lengthDelimited(field, bytes) {
  return [...tag(field, 2), ...varint(bytes.length), ...bytes];
}

function intField(field, value) {
  return [...tag(field, 0), ...varint(value)];
}

function stringField(field, value) {
  return lengthDelimited(field, [...Buffer.from(value, "utf8")]);
}

function tensorType(dims) {
  const shape = dims.flatMap((dimension) => lengthDelimited(1, intField(1, dimension)));
  return lengthDelimited(1, [
    ...intField(1, 1), // TensorProto.DataType.FLOAT
    ...lengthDelimited(2, shape),
  ]);
}

function valueInfo(name, dims) {
  return [
    ...stringField(1, name),
    ...lengthDelimited(2, tensorType(dims)),
  ];
}

/** A tiny valid ONNX Identity graph used to prove native sessions really run. */
function createRuntimeProbeModel() {
  const dimensions = [1, 4, 2, 2];
  const node = [
    ...lengthDelimited(1, [...Buffer.from("input", "utf8")]),
    ...lengthDelimited(2, [...Buffer.from("output", "utf8")]),
    ...stringField(3, "arena-runtime-probe"),
    ...stringField(4, "Identity"),
  ];
  const graph = [
    ...lengthDelimited(1, node),
    ...stringField(2, "arena-native-runtime-probe"),
    ...lengthDelimited(11, valueInfo("input", dimensions)),
    ...lengthDelimited(12, valueInfo("output", dimensions)),
  ];
  const opset = intField(2, 13);
  return Buffer.from([
    ...intField(1, 8),
    ...lengthDelimited(7, graph),
    ...lengthDelimited(8, opset),
  ]);
}

export async function verifyOnnxRuntime(runtime, directory) {
  const modelPath = path.join(directory, "arena-onnx-runtime-probe.onnx");
  const dimensions = [1, 4, 2, 2];
  const values = Float32Array.from({ length: 16 }, (_, index) => (index - 7) / 8);
  let session;

  try {
    await writeFile(modelPath, createRuntimeProbeModel());
    session = await runtime.InferenceSession.create(modelPath, {
      executionProviders: ["cpu"],
    });
    const result = await session.run({
      input: new runtime.Tensor("float32", values, dimensions),
    });
    assert.deepEqual(result.output?.dims, dimensions, "the staged runtime preserves tensor dimensions");
    assert.deepEqual(
      Array.from(result.output?.data ?? []),
      Array.from(values),
      "the staged runtime returns the expected inference output",
    );
  } finally {
    await session?.release?.();
    await rm(modelPath, { force: true });
  }
}
