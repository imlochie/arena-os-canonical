import assert from "node:assert/strict";
import test from "node:test";

import { isLocalMutationAllowed } from "./local-request-gate";

const base = { origin: null, host: null, secFetchSite: null };

test("reads and preflights always pass", () => {
  for (const method of ["GET", "HEAD", "OPTIONS"]) {
    assert.equal(isLocalMutationAllowed({ ...base, method }), true);
  }
});

test("non-browser mutations pass (curl, node fetch, worker, Playwright API)", () => {
  assert.equal(isLocalMutationAllowed({ ...base, method: "POST" }), true);
  assert.equal(isLocalMutationAllowed({ ...base, method: "PUT", origin: "", host: "127.0.0.1:3000" }), true);
  assert.equal(isLocalMutationAllowed({ ...base, method: "DELETE", origin: null, host: "127.0.0.1:3000", secFetchSite: null }), true);
});

test("same-origin browser mutations pass", () => {
  assert.equal(
    isLocalMutationAllowed({ method: "POST", origin: "http://127.0.0.1:41231", host: "127.0.0.1:41231", secFetchSite: "same-origin" }),
    true,
  );
  // Host header case differences do not matter.
  assert.equal(
    isLocalMutationAllowed({ method: "PATCH", origin: "http://LOCALHOST:3000", host: "localhost:3000", secFetchSite: null }),
    true,
  );
});

test("cross-site browser mutations are rejected — the drive-by case", () => {
  // Sec-Fetch-Site alone is enough (modern browsers, Electron Chromium).
  assert.equal(
    isLocalMutationAllowed({ method: "POST", origin: "http://127.0.0.1:41231", host: "127.0.0.1:41231", secFetchSite: "cross-site" }),
    false,
  );
  // Origin/Host mismatch: the classic CSRF signature.
  assert.equal(
    isLocalMutationAllowed({ method: "POST", origin: "https://evil.example", host: "127.0.0.1:41231", secFetchSite: null }),
    false,
  );
  assert.equal(
    isLocalMutationAllowed({ method: "POST", origin: "http://127.0.0.1:9999", host: "127.0.0.1:41231", secFetchSite: null }),
    false,
  );
  // Multipart junk upload from a page — no sec-fetch, mismatched origin.
  assert.equal(
    isLocalMutationAllowed({ method: "POST", origin: "https:// attacker.test".trim(), host: "127.0.0.1:41231", secFetchSite: null }),
    false,
  );
});

test("malformed origin headers are rejected, not guessed", () => {
  assert.equal(isLocalMutationAllowed({ method: "POST", origin: "not a url", host: "127.0.0.1:3000", secFetchSite: null }), false);
  assert.equal(isLocalMutationAllowed({ method: "POST", origin: "http://ok:3000", host: null, secFetchSite: null }), false);
});

test("sec-fetch-site same-site/none pass (same-site is not cross-site)", () => {
  assert.equal(isLocalMutationAllowed({ ...base, method: "POST", secFetchSite: "same-site" }), true);
  assert.equal(isLocalMutationAllowed({ ...base, method: "POST", secFetchSite: "none" }), true);
});
