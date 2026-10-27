import { test } from "node:test";
import assert from "node:assert/strict";
import { dataRoot } from "./data-paths.mjs";

test("retains original Windows data root and explicit portable mode", () => {
  assert.equal(dataRoot({ env: { LOCALAPPDATA: "C:\\Users\\Owner\\AppData\\Local" }, platform: "win32" }), "C:\\Users\\Owner\\AppData\\Local\\Arena");
  assert.equal(dataRoot({ env: {}, exeDir: "D:\\Arena", exists: () => true, platform: "win32" }), "D:\\Arena\\arena-data");
  assert.equal(dataRoot({ env: { ARENA_DATA_DIR: "E:\\Data" }, platform: "win32" }), "E:\\Data");
  assert.throws(() => dataRoot({ env: { ARENA_DATA_DIR: "relative" }, platform: "win32" }));
});
