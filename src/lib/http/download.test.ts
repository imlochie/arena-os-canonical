import test from "node:test";
import assert from "node:assert/strict";
import { attachmentDisposition } from "./download";

test("download names are header-safe ASCII while preserving international UTF-8 names", () => {
  for (const name of ["夜の演奏 🎵.wav", "café.flac", "artist's (live)*.wav", "ordinary.wav"]) {
    const value = attachmentDisposition(name);
    assert.match(value, /^attachment; filename="[\x20-\x7e]+"; filename\*=UTF-8''/);
    const headers = new Headers({ "Content-Disposition": value });
    assert.equal(headers.get("Content-Disposition"), value);
    assert.equal(decodeURIComponent(value.split("filename*=UTF-8''")[1]), name);
  }
});

test("untrusted names cannot inject headers, paths, quoted parameters or malformed UTF-8", () => {
  for (const name of ["../a\\b\r\nSet-Cookie: bad\0.wav", 'a"; x="evil.wav', "bad\ud800.wav", "", ".", ".."]) {
    const value = attachmentDisposition(name);
    assert.doesNotThrow(() => new Headers({ "Content-Disposition": value }));
    const decoded = decodeURIComponent(value.split("filename*=UTF-8''")[1]);
    assert.ok(!/[\p{Cc}/\\]/u.test(decoded));
    assert.ok(decoded !== "." && decoded !== "..");
    assert.equal(value.split('; filename="').length, 2);
  }
});
