import test from "node:test";
import assert from "node:assert/strict";

import { isAllowedFrameUrl } from "./security";

const policy = {
  allowedOrigins: ["http://127.0.0.1:4173"],
  allowFileUrls: true,
};

test("file:// is allowed only when the policy explicitly enables it", () => {
  assert.equal(isAllowedFrameUrl("file:///home/user/app/splash/index.html", policy), true);
  assert.equal(
    isAllowedFrameUrl("file:///home/user/app/splash/index.html", { allowedOrigins: [] }),
    false,
  );
});

test("the app origin is allowed; any other origin is denied", () => {
  assert.equal(isAllowedFrameUrl("http://127.0.0.1:4173/", policy), true);
  assert.equal(isAllowedFrameUrl("http://127.0.0.1:4173/waveyard", policy), true);
  assert.equal(isAllowedFrameUrl("http://127.0.0.1:9999/", policy), false);
  assert.equal(isAllowedFrameUrl("https://arena.example.com/", policy), false);
  assert.equal(isAllowedFrameUrl("http://localhost:4173/", policy), false);
});

test("origin equality, never prefix matching", () => {
  assert.equal(isAllowedFrameUrl("http://127.0.0.1:4173.evil.com/", policy), false);
  assert.equal(isAllowedFrameUrl("http://127.0.0.1:4173@evil.com/", policy), false);
});

test("non-http(s) schemes and garbage are denied", () => {
  assert.equal(isAllowedFrameUrl("javascript:alert(1)", policy), false);
  assert.equal(isAllowedFrameUrl("data:text/html,hi", policy), false);
  assert.equal(isAllowedFrameUrl("not a url", policy), false);
  assert.equal(isAllowedFrameUrl("", policy), false);
});
