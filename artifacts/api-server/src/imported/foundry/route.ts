

import { createApp, deleteApp, getApp, iterateApp, listApps } from "@workspace/arena/lib/foundry";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** GET → the app list (id, name, versions). */
export async function GET() {
  return Response.json({ apps: await listApps() });
}

/**
 * POST {action}:
 *   create  {name?, description, keys?, modelId?} → app + version 1
 *   iterate {appId, change, keys?, modelId?}      → next version
 *   get     {appId}                               → app + latest version
 *   delete  {appId}                               → removed
 */
export async function POST(req: Request) {
  let body: {
    action?: string;
    name?: string;
    description?: string;
    appId?: string;
    change?: string;
    keys?: Record<string, string>;
    modelId?: string;
  } = {};
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  if (body.action === "create") {
    const description = (body.description ?? "").slice(0, 4000);
    if (!description.trim()) return Response.json({ error: "description is required" }, { status: 400 });
    const app = await createApp(description, { name: body.name, keys: body.keys, modelId: body.modelId });
    return Response.json({ app }, { status: 201 });
  }

  if (body.action === "iterate") {
    if (!body.appId) return Response.json({ error: "appId is required" }, { status: 400 });
    const change = (body.change ?? "").slice(0, 4000);
    if (!change.trim()) return Response.json({ error: "change is required" }, { status: 400 });
    const version = await iterateApp(body.appId, change, { keys: body.keys, modelId: body.modelId });
    if (!version) return Response.json({ error: "app not found" }, { status: 404 });
    return Response.json({ version }, { status: 201 });
  }

  if (body.action === "get") {
    if (!body.appId) return Response.json({ error: "appId is required" }, { status: 400 });
    const app = await getApp(body.appId);
    if (!app) return Response.json({ error: "app not found" }, { status: 404 });
    return Response.json({ app });
  }

  if (body.action === "delete") {
    if (!body.appId) return Response.json({ error: "appId is required" }, { status: 400 });
    return Response.json({ removed: await deleteApp(body.appId) });
  }

  return Response.json({ error: "unknown action (create|iterate|get|delete)" }, { status: 400 });
}
