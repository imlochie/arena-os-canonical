import { test } from "node:test";
import assert from "node:assert/strict";
import { configuredChromiumPath, resolveWorkspaceRoot } from "./runtime-paths";

test("Windows state survives changes to the installation working directory", () => {
  const env = { LOCALAPPDATA: "C:\\Users\\Owner\\AppData\\Local" };
  const expected = "C:\\Users\\Owner\\AppData\\Local\\Arena\\data\\space-workspaces";
  assert.equal(resolveWorkspaceRoot(env, "win32", "C:\\Program Files\\Arena"), expected);
  assert.equal(resolveWorkspaceRoot(env, "win32", "C:\\Windows\\System32"), expected);
  assert.equal(resolveWorkspaceRoot({ ARENA_DATA_DIR: "D:\\Arena portable" }, "win32"), "D:\\Arena portable\\data\\space-workspaces");
  assert.throws(() => resolveWorkspaceRoot({ ARENA_DATA_DIR: "relative" }, "win32"));
  assert.throws(() => resolveWorkspaceRoot({}, "win32"));
});

test("hosted paths remain unchanged; packaged Chromium stays outside asar", () => {
  assert.equal(resolveWorkspaceRoot({}, "linux", "/srv/api"), "/srv/api/.data/space-workspaces");
  assert.equal(configuredChromiumPath({ ARENA_RESOURCES_DIR: "C:\\Program Files\\Arena\\resources" }, "win32"),
    "C:\\Program Files\\Arena\\resources\\chromium\\chrome.exe");
  assert.equal(configuredChromiumPath({ CHROMIUM_PATH: "D:\\Chrome\\chrome.exe" }, "win32"), "D:\\Chrome\\chrome.exe");
  assert.throws(() => configuredChromiumPath({ CHROMIUM_PATH: "chrome.exe" }, "win32"));
});
