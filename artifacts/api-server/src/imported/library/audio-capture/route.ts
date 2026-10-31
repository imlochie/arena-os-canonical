import {
  GetLibraryAudioCaptureOptionsResponse,
  StartLibraryAudioCaptureBody,
  StartLibraryAudioCaptureResponse,
} from "@workspace/api-zod";
import { requireUser } from "@workspace/arena/lib/waveyard/local-context";
import {
  getAudioCaptureOptions,
  startAudioCapture,
} from "../../../lib/waveyard/audio-capture-manager";

export const runtime = "nodejs";

export async function GET() {
  try {
    const user = await requireUser();
    return Response.json(GetLibraryAudioCaptureOptionsResponse.parse(await getAudioCaptureOptions(user.id)));
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({
      available: false,
      devices: [],
      reason: error instanceof Error ? error.message : "Windows audio capture is unavailable.",
    }, { status: 200 });
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireUser();
    const parsed = StartLibraryAudioCaptureBody.safeParse(await request.json());
    if (!parsed.success) {
      return Response.json({ error: parsed.error.message }, { status: 400 });
    }

    const options = await getAudioCaptureOptions();
    if (!options.available) {
      return Response.json({ error: options.reason || "Windows audio capture is unavailable." }, { status: 503 });
    }
    if (parsed.data.deviceId && !options.devices.some((device) => device.id === parsed.data.deviceId)) {
      return Response.json({ error: "The selected Windows playback endpoint is no longer available." }, { status: 409 });
    }

    const session = await startAudioCapture(user.id, parsed.data);
    return Response.json(StartLibraryAudioCaptureResponse.parse({
      sessionId: session.sessionId,
      status: "recording",
      startedAt: session.startedAt,
      format: session.format,
    }), { status: 201 });
  } catch (error) {
    if (error instanceof Response) return error;
    const message = error instanceof Error ? error.message : "Could not start audio capture.";
    const status = /not available|unavailable|capture host/i.test(message) ? 503 : 409;
    return Response.json({ error: message }, { status });
  }
}
