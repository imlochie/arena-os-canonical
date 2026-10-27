import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { getSpace } from "@workspace/arena/lib/spaces";
import { browserProfileDir, claimBrowserWorkspace, engineFor, workspaceDirFor } from "@workspace/arena/lib/spaces/browser";
import { assertOutboundUrl, OutboundUrlError } from "@workspace/arena/lib/security/outbound-url";

type Context = { params: Promise<{ id: string }> };
const STATE_FILE = "browser-observation.json";

export async function GET(req: Request, ctx: Context) {
  const { id } = await ctx.params;
  if (!await getSpace(id)) return Response.json({ error: "Workspace not found" }, { status: 404 });
  browserProfileDir(id); // Validate before using this ID as a filesystem path.
  const query = new URL(req.url).searchParams;
  const file = query.get("file");
  if (file) {
    const normalized = file.replaceAll("\\", "/");
    if (!/^reports\/[a-zA-Z0-9_./-]+$/.test(normalized) || normalized.split("/").includes("..")) {
      return Response.json({ error: "Invalid report path" }, { status: 400 });
    }
    try {
      const workspace = await realpath(workspaceDirFor(id));
      const target = await realpath(path.join(workspace, normalized));
      if (!target.startsWith(path.join(workspace, "reports") + path.sep)) return Response.json({ error: "Invalid report path" }, { status: 400 });
      if ((await stat(target)).size > 2_000_000) return Response.json({ error: "Report exceeds the download limit" }, { status: 413 });
      return new Response(new Uint8Array(await readFile(target)), {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Disposition": `attachment; filename="${path.basename(normalized)}"`,
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch {
      return Response.json({ error: "Report not found" }, { status: 404 });
    }
  }
  const image = query.get("image");
  if (image) {
    if (!/^browser-\d+\.png$/.test(image)) return Response.json({ error: "Invalid capture" }, { status: 400 });
    try {
      const workspace = await realpath(workspaceDirFor(id));
      const target = await realpath(path.join(workspace, image));
      if (path.dirname(target) !== workspace || path.basename(target) !== image) return Response.json({ error: "Invalid capture path" }, { status: 400 });
      if ((await stat(target)).size > 5_000_000) return Response.json({ error: "Capture exceeds the preview limit" }, { status: 413 });
      const bytes = await readFile(target);
      return new Response(new Uint8Array(bytes), { headers: { "Content-Type": "image/png", "Cache-Control": "private, no-store" } });
    } catch {
      return Response.json({ error: "Capture not found" }, { status: 404 });
    }
  }
  try {
    const state = JSON.parse(await readFile(path.join(workspaceDirFor(id), STATE_FILE), "utf8"));
    return Response.json({ state }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return Response.json({ state: null });
    return Response.json({ error: "Could not load the saved browser observation" }, { status: 500 });
  }
}

// Explicitly open and inspect a page without requiring an AI model. The same
// engine/profile is used by browser tools during automated missions.
export async function POST(req: Request, ctx: Context) {
  const { id } = await ctx.params;
  if (!await getSpace(id)) return Response.json({ error: "Workspace not found" }, { status: 404 });
  let body: { url?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "A page URL is required" }, { status: 400 });
  }
  const url = String(body.url ?? "").trim();
  if (!url || url.length > 4000) return Response.json({ error: "Enter a page URL" }, { status: 400 });
  const releaseWorkspace = claimBrowserWorkspace(id);
  if (!releaseWorkspace) return Response.json({ error: "This workspace is running a browser task. Wait for it to finish or pause for approval before navigating." }, { status: 409 });
  try {
    await assertOutboundUrl(url, "public");
    const engine = engineFor(id);
    await engine.ensure(browserProfileDir(id));
    const snapshot = await engine.navigate(url);
    const screenshotFile = path.basename(await engine.screenshot(workspaceDirFor(id)));
    const state = { ...snapshot, screenshotFile, capturedAt: new Date().toISOString() };
    await writeFile(path.join(workspaceDirFor(id), STATE_FILE), JSON.stringify(state, null, 2));
    return Response.json({ state });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "The browser could not open this page" },
      { status: error instanceof OutboundUrlError ? 400 : 503 },
    );
  } finally {
    releaseWorkspace();
  }
}
