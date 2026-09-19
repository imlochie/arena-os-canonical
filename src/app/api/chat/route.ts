import { runChat } from "@/lib/chatRunner";
import { internalAuthState, internalUnauthorizedResponse } from "@/lib/internal-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Browser leg of the reasoning route.
 *
 * Credential rules (server-only ARENA_INTERNAL_API_KEY):
 *   - no Authorization header            → browser call (the app's normal
 *                                          chat flow sends none);
 *   - Bearer == internal key             → internal service caller (kept for
 *                                          compatibility with Archive
 *                                          Assistant's canonical client,
 *                                          which posts Bearer $ARENA_CANONICAL_API_KEY
 *                                          to this path); archive evidence
 *                                          forwarding is NOT honored — a
 *                                          service credential is not a user
 *                                          identity;
 *   - Bearer != internal key             → only tolerated when the call
 *                                          requests archiveContext (it is
 *                                          then a user token forwarded to
 *                                          Archive Assistant, which validates
 *                                          it); otherwise 401.
 */
export async function POST(req: Request) {
  const auth = internalAuthState(req);

  let wantsArchive = false;
  let body: any;
  try {
    body = await req.json();
    wantsArchive = body?.archiveContext === true;
  } catch {
    body = {};
  }

  if (auth.status === "invalid" && !wantsArchive) {
    return internalUnauthorizedResponse();
  }

  const result = await runChat({
    body,
    authorization: req.headers.get("authorization"),
    caller: auth.status === "ok" ? "internal_service" : "browser",
  });
  return Response.json(result.body, { status: result.status });
}
