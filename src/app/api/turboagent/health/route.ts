// Probe a local TurboAgent server (OpenAI-compatible, MIT —
// https://github.com/TurboAgentAI/turboagent). Server-side probe avoids any
// browser CORS/mixed-content issues. The URL comes from the client (browser
// localStorage via the keys bar) or the TURBOAGENT_URL env var.
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  let target = url.searchParams.get("url")?.trim() || process.env.TURBOAGENT_URL || "";
  if (!target) {
    return Response.json({ online: false, detail: "no URL configured (set one in the 🔑 keys bar)" });
  }
  if (!/^https?:\/\//i.test(target)) target = `http://${target}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 2500);
  try {
    const res = await fetch(`${target.replace(/\/$/, "")}/health`, { signal: ctrl.signal });
    if (!res.ok) return Response.json({ online: false, url: target, detail: `health ${res.status}` });
    const data = await res.json();
    return Response.json({
      online: true,
      url: target,
      detail: data?.model ? String(data.model) : "ready",
      backend: data?.backend ? String(data.backend) : undefined,
      kvMode: data?.kv_mode ? String(data.kv_mode) : undefined,
      version: data?.version ? String(data.version) : undefined,
    });
  } catch {
    return Response.json({ online: false, url: target, detail: "unreachable — start `turboagent serve`" });
  } finally {
    clearTimeout(t);
  }
}
