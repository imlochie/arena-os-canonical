import { startWaveyardLocalSync, stopWaveyardLocalSync } from "../../../lib/waveyard/local-sync";

export async function POST(request: Request) {
  if (process.env.ARENA_DESKTOP_MODE !== "1") {
    return Response.json(
      { error: "Private QR pairing is available when Waveyard runs on your desktop." },
      { status: 403, headers: { "cache-control": "no-store" } },
    );
  }

  let body: { action?: unknown; hostToken?: unknown };
  try {
    body = await request.json() as typeof body;
  } catch {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }

  if (body.action === "start") {
    try {
      const result = await startWaveyardLocalSync({
        hostOrigin: new URL(request.url).origin,
      });
      return Response.json(result, { headers: { "cache-control": "no-store" } });
    } catch (error) {
      const message = error instanceof Error ? error.message : "LOCAL_SYNC_START_FAILED";
      const response = message === "LOCAL_SYNC_NO_PRIVATE_NETWORK"
        ? "Connect the desktop and phone to the same private Wi-Fi network, then try again."
        : "Arena could not open a private local connection. Check that the app is allowed on your private network.";
      return Response.json({ error: response }, { status: 503, headers: { "cache-control": "no-store" } });
    }
  }

  if (body.action === "stop") {
    if (typeof body.hostToken !== "string") {
      return Response.json({ error: "Host authorization is required." }, { status: 400 });
    }
    try {
      await stopWaveyardLocalSync(body.hostToken);
      return Response.json({ stopped: true }, { headers: { "cache-control": "no-store" } });
    } catch {
      return Response.json({ error: "This local sharing session is no longer active." }, { status: 401 });
    }
  }

  return Response.json({ error: "Choose start or stop." }, { status: 400 });
}
