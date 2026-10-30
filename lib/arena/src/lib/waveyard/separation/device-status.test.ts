import assert from "node:assert/strict";
import test from "node:test";

import { separationDeviceHint, separationDeviceLabel } from "./device-status";

test("separation device status distinguishes an actual CPU choice from an accelerator fallback", () => {
  assert.equal(separationDeviceLabel("cpu", "cpu"), "CPU");
  assert.equal(separationDeviceHint("cpu", "cpu"), "This job completed on CPU.");
  assert.equal(separationDeviceLabel("auto", "cpu"), "CPU fallback");
  assert.match(separationDeviceHint("auto", "cpu") ?? "", /may take longer/);
  assert.equal(separationDeviceLabel("cuda", "cpu"), "CPU fallback");
});

test("separation device status names the resolved accelerator", () => {
  assert.equal(separationDeviceLabel("auto", "dml"), "DirectML");
  assert.equal(separationDeviceHint("auto", "dml"), "This job used the DirectML execution provider.");
  assert.equal(separationDeviceLabel("auto", "cuda"), "CUDA");
  assert.equal(separationDeviceLabel("auto", null), null);
});
