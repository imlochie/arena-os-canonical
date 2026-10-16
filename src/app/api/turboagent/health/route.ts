// Probe a local TurboAgent server (OpenAI-compatible, MIT —
// https://github.com/TurboAgentAI/turboagent). Server-side probe avoids any
// browser CORS/mixed-content issues. The URL comes from the client (browser
// localStorage via the keys bar) or the TURBOAGENT_URL env var.
import { requireApiAccess } from "@/lib/security/api-access";
import { safeFetch, SsrfError } from "@/lib/security/safe-fetch";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const denied = await requireApiAccess(req);
  if (denied) return denied;
  const url = new URL(req.url);
  const requested = url.searchParams.get("url")?.trim() ?? "";
  const fromEnv = requested === "";
  let target = requested || process.env.TURBOAGENT_URL || "";
  if (!target) {
    return Response.json({ online: false, detail: "no URL configured (set one in the 🔑 keys bar)" });
  }
  if (!/^https?:\/\//i.test(target)) target = `http://${target}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 2500);
  try {
    const healthUrl = `${target.replace(/\/$/, "")}/health`;
    // A caller-supplied URL may only probe loopback (the local TurboAgent); the
    // owner-configured env URL is trusted but still never follows redirects.
    const res = fromEnv
      ? await fetch(healthUrl, { signal: ctrl.signal, redirect: "manual" })
      : await safeFetch(healthUrl, { signal: ctrl.signal }, { policy: "loopback", maxRedirects: 0 });
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
  } catch (error) {
    if (error instanceof SsrfError) {
      return Response.json({ online: false, detail: `URL not allowed: ${error.message}` }, { status: 400 });
    }
    return Response.json({ online: false, url: target, detail: "unreachable — start `turboagent serve`" });
  } finally {
    clearTimeout(t);
  }
}
