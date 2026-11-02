import assert from "node:assert/strict";
import test from "node:test";
import {
  decryptLocalSessionPayload,
  encryptLocalSessionPayload,
  fromBase64Url,
  toBase64Url,
} from "./local-session-crypto";

test("local session packets round-trip and use a unique nonce for each message", () => {
  const key = toBase64Url(new Uint8Array(32).fill(19));
  const senderId = toBase64Url(new Uint8Array(16).fill(7));
  const first = encryptLocalSessionPayload(key, senderId, 1, { track: "one", position: 12 });
  const second = encryptLocalSessionPayload(key, senderId, 2, { track: "two", position: 18 });

  assert.deepEqual(
    decryptLocalSessionPayload(key, first),
    { track: "one", position: 12 },
  );
  assert.notEqual(first.ciphertext, second.ciphertext);
  assert.deepEqual(
    fromBase64Url(toBase64Url(new Uint8Array([0, 1, 2, 253, 254, 255]))),
    new Uint8Array([0, 1, 2, 253, 254, 255]),
  );
});

test("local session packets reject altered ciphertext", () => {
  const key = toBase64Url(new Uint8Array(32).fill(29));
  const senderId = toBase64Url(new Uint8Array(16).fill(13));
  const packet = encryptLocalSessionPayload(key, senderId, 1, { command: "play" });
  const bytes = fromBase64Url(packet.ciphertext);
  bytes[bytes.length - 1] ^= 0x80;

  assert.throws(
    () => decryptLocalSessionPayload(key, { ...packet, ciphertext: toBase64Url(bytes) }),
    /authentication failed/,
  );
});
