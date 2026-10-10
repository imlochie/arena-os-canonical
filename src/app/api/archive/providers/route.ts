import {
  MediaProviderError,
  isMediaProviderKind,
} from "@/lib/mediaArchive/types";
import {
  deleteMediaProvider,
  listMediaProviders,
  runProviderSync,
  saveMediaProvider,
  testMediaProviderConnection,
} from "@/lib/mediaArchive/sync";
import { runReconciliation } from "@/lib/mediaArchive/reconcile";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// GET → configured providers (tokens never included) + their last refresh rows
export async function GET() {
  try {
    const providers = await listMediaProviders();
    return Response.json({ providers });
  } catch (e) {
    console.error(e);
    return Response.json({ providers: [] });
  }
}

// POST {action}:
//   test       {kind, baseUrl, token, username?}
//   save       {kind, name?, baseUrl, token, username?}
//   delete     {kind}
//   sync       {kind}
//   reconcile  {}
export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "bad_input", message: "JSON body required." }, { status: 400 });
  }
  const action = String(body.action ?? "");
  const kindRaw = String(body.kind ?? "");
  if (action !== "reconcile" && !isMediaProviderKind(kindRaw)) {
    return Response.json({ error: "bad_input", message: "kind must be plex or jellyfin." }, { status: 400 });
  }

  try {
    if (action === "test") {
      const result = await testMediaProviderConnection({
        kind: kindRaw as "plex" | "jellyfin",
        baseUrl: String(body.baseUrl ?? ""),
        token: String(body.token ?? ""),
        username: body.username === undefined ? undefined : String(body.username),
      });
      return Response.json(result);
    }
    if (action === "save") {
      const provider = await saveMediaProvider({
        kind: kindRaw as "plex" | "jellyfin",
        name: body.name === undefined ? undefined : String(body.name),
        baseUrl: String(body.baseUrl ?? ""),
        token: String(body.token ?? ""),
        username: body.username === undefined ? undefined : String(body.username),
      });
      return Response.json({ provider }, { status: 201 });
    }
    if (action === "delete") {
      const removed = await deleteMediaProvider(kindRaw as "plex" | "jellyfin");
      return Response.json({ removed });
    }
    if (action === "sync") {
      const outcome = await runProviderSync(kindRaw as "plex" | "jellyfin");
      return Response.json({ outcome });
    }
    if (action === "reconcile") {
      const summary = await runReconciliation();
      return Response.json({ summary });
    }
    return Response.json({ error: "bad_input", message: "Unknown action." }, { status: 400 });
  } catch (e) {
    if (e instanceof MediaProviderError) {
      const status = e.code === "auth_failed" ? 401 : e.code === "not_configured" ? 404 : 502;
      return Response.json({ error: e.code, message: e.message }, { status });
    }
    console.error(e);
    return Response.json({ error: "provider_route_failed", message: "Unexpected error." }, { status: 500 });
  }
}
