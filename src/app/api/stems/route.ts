export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

function workerUrl() {
  return process.env.STEM_WORKER_URL?.replace(/\/$/, "");
}

// This route is deliberately a narrow adapter. It forwards work only to the
// operator-configured local/self-hosted worker. It never supplies mock stems or
// an offline text substitute when a worker is unavailable.
export async function POST(request: Request) {
  const target = workerUrl();
  if (!target) {
    return Response.json({ error: "Stem separation is unavailable: configure a real local STEM_WORKER_URL first." }, { status: 503 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ error: "A multipart audio upload is required." }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return Response.json({ error: "Choose an audio file to send to the configured worker." }, { status: 400 });
  if (file.size > Number(process.env.STEM_MAX_UPLOAD_BYTES ?? 524_288_000)) {
    return Response.json({ error: "Audio file exceeds the configured stem-worker upload limit." }, { status: 413 });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 55_000);
  try {
    const upstream = await fetch(`${target}/v1/separations`, {
      method: "POST",
      body: form,
      signal: controller.signal,
      headers: { "X-Arena-Project": String(form.get("projectId") ?? "") },
    });
    const body = await upstream.json().catch(() => ({ error: "Stem worker returned an invalid response." }));
    return Response.json(body, { status: upstream.status });
  } catch {
    return Response.json({ error: "The configured stem worker did not accept the separation request." }, { status: 503 });
  } finally {
    clearTimeout(timeout);
  }
}
