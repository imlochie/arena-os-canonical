import test from "node:test";
import assert from "node:assert/strict";

import { DesktopAppInfoSchema, IPC_CHANNELS, DESKTOP_INFO_CHANNEL, isIpcChannel } from "./contracts";

const validInfo = {
  name: "Arena",
  version: "0.1.0",
  platform: "win32",
  arch: "x64",
  electron: "39.0.0",
  chrome: "142.0.0",
  node: "22.0.0",
  dataDir: String.raw`C:\Users\lochi\AppData\Local\Arena`,
  portable: false,
  channel: "dev",
};

test("DesktopAppInfo validates a real shape round-trip", () => {
  const parsed = DesktopAppInfoSchema.parse(validInfo);
  assert.equal(parsed.name, "Arena");
  assert.equal(parsed.dataDir, validInfo.dataDir);
});

test("DesktopAppInfo rejects wrong types and unknown channels", () => {
  assert.equal(DesktopAppInfoSchema.safeParse({ ...validInfo, portable: "yes" }).success, false);
  assert.equal(DesktopAppInfoSchema.safeParse({ ...validInfo, channel: "nightly" }).success, false);
  assert.equal(DesktopAppInfoSchema.safeParse({ ...validInfo, version: "" }).success, false);
});

test("the IPC allowlist is exactly the declared channels", () => {
  assert.deepEqual([...IPC_CHANNELS], [DESKTOP_INFO_CHANNEL]);
  assert.equal(isIpcChannel("app:getInfo"), true);
  assert.equal(isIpcChannel("shell:executeAnything"), false);
  assert.equal(isIpcChannel("child_process:spawn"), false);
  assert.equal(isIpcChannel(42), false);
});
