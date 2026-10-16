/**
 * Cheap request-size guard. Runs BEFORE the body is buffered (formData()/json()
 * read the whole request into memory), so an oversized declared upload is
 * refused without allocating it.
 *
 * Limitation: a client that omits Content-Length (chunked transfer) is not
 * caught here; the post-parse size checks in each route remain the backstop.
 */



/** `overheadBytes` allows for multipart boundaries and the non-file form fields. */
export function rejectOversizedBody(request: Request, maxBytes: number, overheadBytes = 1_048_576): Response | null {
  const declared = request.headers.get("content-length");
  if (declared === null) return null;
  const length = Number(declared);
  if (!Number.isFinite(length) || length < 0) {
    return Response.json({ error: "Invalid Content-Length." }, { status: 400 });
  }
  if (length > maxBytes + overheadBytes) {
    return Response.json({ error: `Request body is larger than the ${maxBytes}-byte limit.` }, { status: 413 });
  }
  return null;
}
