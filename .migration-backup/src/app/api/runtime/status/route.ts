import { probeRuntimeStatus } from "@/lib/runtimeStatus";

export const dynamic = "force-dynamic";

// GET (or POST with a client-side TurboAgent URL) → live runtime status.
// The TurboAgent URL is user configuration that lives in the browser; it is
// passed per-request, never stored server-side.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const turboagentUrl = url.searchParams.get("turboagent");
  const report = await probeRuntimeStatus(fetch, { turboagentUrl });
  return Response.json(report);
}

export async function POST(req: Request) {
  let body: any = {};
  try {
    body = await req.json();
  } catch {}
  const report = await probeRuntimeStatus(fetch, { turboagentUrl: body.turboagent });
  return Response.json(report);
}
