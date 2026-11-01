import {
  GetLibraryAudioCaptureOptionsResponse,
  StartLibraryAudioCaptureBody,
  StartLibraryAudioCaptureResponse,
} from "@workspace/api-zod";
import { requireUser } from "@workspace/arena/lib/waveyard/local-context";
import {
  getAudioCaptureOptions,
  getWindowsMediaMetadata,
  startAudioCapture,
} from "../../../lib/waveyard/audio-capture-manager";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const options = await getAudioCaptureOptions(user.id);
    const mediaMetadata = new URL(request.url).searchParams.get("mediaMetadata") === "1"
      ? await getWindowsMediaMetadata() : undefined;
    return Response.json(GetLibraryAudioCaptureOptionsResponse.parse({ ...options, ...(mediaMetadata ? { mediaMetadata } : {}) }));
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
    const applicationMode = parsed.data.processId !== undefined || parsed.data.processStartTime !== undefined;
    if (applicationMode && (parsed.data.processId === undefined || !parsed.data.processStartTime || parsed.data.deviceId !== undefined))
      return Response.json({ error: "Choose one application with its process identity, or one whole-output device." }, { status: 400 });

    const options = await getAudioCaptureOptions();
    if (!options.available) {
      const insufficientStorage = (options.storage && !options.storage.canRecord) ||
        /free disk space/i.test(options.reason ?? "");
      return Response.json(
        { error: options.reason || "Windows audio capture is unavailable." },
        { status: insufficientStorage ? 507 : 503 },
      );
    }
    if (parsed.data.deviceId && !options.devices.some((device) => device.id === parsed.data.deviceId)) {
      return Response.json({ error: "The selected Windows playback endpoint is no longer available." }, { status: 409 });
    }
    if (applicationMode && (!options.processLoopbackSupported || !options.applications?.some((app) =>
      app.processId === parsed.data.processId && app.processStartTime === parsed.data.processStartTime))) {
      return Response.json({ error: options.processLoopbackSupported
        ? "The selected application exited or restarted. Refresh applications and select it again."
        : options.processLoopbackReason || "Application capture is unavailable. Choose whole output explicitly." }, { status: 409 });
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
    const status = /free at least|disk space could not be checked/i.test(message)
      ? 507
      : /not available|unavailable|capture host/i.test(message)
        ? 503
        : 409;
    return Response.json({ error: message }, { status });
  }
}
