/**
 * Request-body limits for upload routes.
 *
 * `request.formData()` buffers the whole multipart body before any handler
 * sees a size field — a chunked request with no Content-Length can exhaust
 * memory before an `upload.size` check ever runs. This helper bounds the
 * read: a declared Content-Length over the limit is refused before a byte
 * is read, and an undeclared/chunked body is cut off at the limit while it
 * streams. Either path returns a clean 413 instead of an OOM.
 */

export interface BodyLimitResult {
  ok: boolean;
  form?: FormData;
  error?: Response;
}

/** Multipart framing slack over the declared file limit: enough for headers
 *  and fields, capped at 1 MiB, and never a meaningful fraction of a small
 *  limit (so tiny limits stay enforceable). */
export function multipartSlack(maxBytes = 524_288_000): number {
  return Math.min(1024 * 1024, Math.max(4096, Math.floor(maxBytes * 0.05)));
}

export async function guardedFormData(request: Request, maxBytes: number): Promise<BodyLimitResult> {
  const limit = maxBytes + multipartSlack(maxBytes);

  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > limit) {
    return {
      ok: false,
      error: Response.json(
        { error: `Request body exceeds the ${maxBytes}-byte upload limit.` },
        { status: 413, headers: { "cache-control": "no-store" } },
      ),
    };
  }

  // Chunked / undeclared length: count as we read and stop at the limit.
  if (request.body === null) {
    return { ok: true, form: await request.formData().catch(() => new FormData()) };
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > limit) {
      await reader.cancel().catch(() => undefined);
      return {
        ok: false,
        error: Response.json(
          { error: `Request body exceeds the ${maxBytes}-byte upload limit.` },
          { status: 413, headers: { "cache-control": "no-store" } },
        ),
      };
    }
    chunks.push(value);
  }

  const body = new Blob(chunks as unknown as BlobPart[]);
  const replay = new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body,
  });
  try {
    return { ok: true, form: await replay.formData() };
  } catch {
    return {
      ok: false,
      error: Response.json({ error: "Malformed multipart body." }, { status: 400 }),
    };
  }
}
