import { NextResponse, type NextRequest } from "next/server";

import { isLocalMutationAllowed } from "@/lib/security/local-request-gate";
import { isLoopbackHost } from "@/lib/security/loopback-host";

/**
 * Mutation gate for the local-first deployment — blocks browser drive-by
 * CSRF against the 127.0.0.1 server (websites cannot mutate local state via
 * simple-content-type POSTs). Pure header logic; see
 * @/lib/security/local-request-gate for the rules and tests.
 *
 * Next 16 file convention: proxy.ts (middleware.ts is deprecated).
 */
export function proxy(request: NextRequest) {
  // Desktop server is loopback-only: a foreign Host means DNS rebinding or a LAN client.
  if (process.env.ARENA_DESKTOP_MODE === "1" && !isLoopbackHost(request.headers.get("host"))) {
    return new NextResponse(JSON.stringify({ error: "Arena desktop only serves loopback hosts." }), {
      status: 403,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }
  const allowed = isLocalMutationAllowed({
    method: request.method,
    origin: request.headers.get("origin"),
    host: request.headers.get("host"),
    secFetchSite: request.headers.get("sec-fetch-site"),
  });
  if (!allowed) {
    return new NextResponse(JSON.stringify({ error: "Cross-origin requests cannot change local data." }), {
      status: 403,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico).*)"],
};
