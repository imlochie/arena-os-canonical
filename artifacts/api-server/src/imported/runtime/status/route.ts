import { probeTurboAgent } from "@workspace/arena/lib/ai";
import { probeRuntimeStatus } from "@workspace/arena/lib/runtimeStatus";

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
  if (body?.scope === "arcade-turboagent") {
    const modelId = typeof body.modelId === "string" ? body.modelId.trim() : "";
    if (!modelId) {
      return Response.json({
        probe: {
          status: "model-unavailable",
          detail: "No selected TurboAgent model could be identified.",
          recovery: "Choose a listed TurboAgent model in Arcade model setup.",
        },
      });
    }
    // This scope intentionally probes only the saved local endpoint. It must
    // never run the remote-provider probes used by the general runtime page.
    const probe = await probeTurboAgent(fetch, typeof body.turboagent === "string" ? body.turboagent : null, modelId);
    return Response.json({ probe });
  }
  const report = await probeRuntimeStatus(fetch, { turboagentUrl: body.turboagent });
  return Response.json(report);
}
