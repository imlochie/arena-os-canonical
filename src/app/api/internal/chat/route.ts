import { runChat } from "@/lib/chatRunner";
import {
  internalAuthState,
  internalNotConfiguredResponse,
  internalUnauthorizedResponse,
} from "@/lib/internal-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Service leg of the reasoning route — the authenticated machine bridge
 * (Archive Assistant's canonical client and any future internal services).
 *
 * Truth table (server-only ARENA_INTERNAL_API_KEY):
 *   key not configured   → 503 (fail closed: an open internal route is worse
 *                          than none)
 *   missing secret       → 401
 *   wrong secret         → 401 (identical body: no missing-vs-wrong oracle)
 *   correct secret       → allowed
 *
 * The secret never crosses the browser: browser flows send no Authorization
 * header at all, so this route cannot be confused with a browser call.
 *
 * Archive evidence forwarding is intentionally not honored on this leg: the
 * internal credential authenticates a service, not an owner identity, so it
 * is never forwarded to Archive Assistant.
 */
export async function POST(req: Request) {
  const auth = internalAuthState(req);
  if (auth.status === "not_configured") return internalNotConfiguredResponse();
  if (auth.status !== "ok") return internalUnauthorizedResponse();

  let body: any;
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const result = await runChat({
    body,
    authorization: req.headers.get("authorization"),
    caller: "internal_service",
  });
  return Response.json(result.body, { status: result.status });
}
