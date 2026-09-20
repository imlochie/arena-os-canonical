export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function workerUrl() {
  return process.env.STEM_WORKER_URL?.replace(/\/$/, "");
}

export async function GET() {
  const target = workerUrl();
  if (!target) {
    return Response.json({
      available: false,
      reason: "No STEM_WORKER_URL is configured. Arena will not simulate separation without a real worker.",
    });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const result = await fetch(`${target}/health`, { signal: controller.signal, cache: "no-store" });
    const body = await result.json().catch(() => ({}));
    if (!result.ok) {
      return Response.json({ available: false, reason: body?.error ?? `Stem worker returned ${result.status}.` }, { status: 503 });
    }
    return Response.json({ available: body?.available !== false, engine: body?.engine ?? "unknown", model: body?.model ?? "unknown", device: body?.device ?? "unknown" });
  } catch {
    return Response.json({ available: false, reason: "The configured stem worker could not be reached." }, { status: 503 });
  } finally {
    clearTimeout(timeout);
  }
}
