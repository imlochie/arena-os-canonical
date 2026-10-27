/**
 * Upload body-limit tests: a declared oversize body and a chunked body
 * without Content-Length must both fail with 413 BEFORE the parser buffers
 * them; normal uploads still parse.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { guardedFormData, multipartSlack } from "./request-limits";

const BOUNDARY = "----arena-test-boundary";

function multipartBody(fileBytes: number): string {
  return (
    `--${BOUNDARY}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="clip.wav"\r\n` +
    `Content-Type: audio/wav\r\n\r\n` +
    "x".repeat(fileBytes) +
    `\r\n--${BOUNDARY}--\r\n`
  );
}

function multipartRequest(body: string, headers: Record<string, string> = {}): Request {
  return new Request("http://arena.test/api/uploads", {
    method: "POST",
    headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}`, ...headers },
    body,
  });
}

test("a declared Content-Length over the limit is refused before parsing", async () => {
  const request = multipartRequest(multipartBody(1024), { "content-length": String(10_000) });
  const result = await guardedFormData(request, 5_000);
  assert.equal(result.ok, false);
  assert.equal(result.error?.status, 413);
});

test("a chunked body without Content-Length is cut off at the limit", async () => {
  const raw = multipartBody(20_000);
  // Streamed body, no content-length: exactly the shape the guard exists for.
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < raw.length; i += 512) {
        controller.enqueue(new TextEncoder().encode(raw.slice(i, i + 512)));
      }
      controller.close();
    },
  });
  const request = new Request("http://arena.test/api/uploads", {
    method: "POST",
    headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
    body: stream,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  const result = await guardedFormData(request, 5_000);
  assert.equal(result.ok, false);
  assert.equal(result.error?.status, 413);
});

test("a normal upload parses and the file is intact", async () => {
  const request = multipartRequest(multipartBody(2_000));
  const result = await guardedFormData(request, 5_000);
  assert.equal(result.ok, true);
  const file = result.form?.get("file");
  assert.ok(file instanceof File);
  assert.equal((file as File).size, 2_000);
  assert.equal((file as File).name, "clip.wav");
});

test("the multipart slack is bounded and explicit", () => {
  assert.ok(multipartSlack() > 0 && multipartSlack() <= 1024 * 1024);
  assert.ok(multipartSlack(5_000) <= 5_000, "slack never dwarfs a small limit");
});
