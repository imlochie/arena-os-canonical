import { tickSpaces } from "@/lib/spaces";
import { isLocalOnlyBody } from "@/lib/privacy";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// The workbench heartbeat: run up to a few due spaces (bounded work per
// request). Polled by the workbench page and every popped-out window.
export async function POST(req: Request) {
  let body: any = {};
  try {
    body = await req.json();
  } catch {
    /* body optional */
  }
  const limit = Math.min(4, Math.max(1, Number(body?.limit) || 2));
  const localOnly = isLocalOnlyBody(body);
  try {
    const result = await tickSpaces(limit, {
      keys: localOnly ? undefined : body?.keys,
      localOnly,
    });
    return Response.json(result);
  } catch (e) {
    const message = e instanceof Error ? e.message : "tick failed";
    return Response.json({ error: message }, { status: 500 });
  }
}
