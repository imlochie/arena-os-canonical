import { isUuid } from "@/lib/api/ids";
import { requireApiAccess } from "@/lib/security/api-access";
import { NextResponse } from "next/server";

import { createApp, deleteApp, getApp, iterateApp, listApps } from "@/lib/foundry";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** GET → the app list (id, name, versions). */
export async function GET(req: Request) {
  const denied=await requireApiAccess(req); if(denied)return denied;
  try{return NextResponse.json({ apps: await listApps() });}catch{return NextResponse.json({error:"App library unavailable. Retained apps were not removed; retry."},{status:503});}
}

/**
 * POST {action}:
 *   create  {name?, description, keys?, modelId?} → app + version 1
 *   iterate {appId, change, keys?, modelId?}      → next version
 *   get     {appId}                               → app + latest version
 *   delete  {appId}                               → removed
 */
export async function POST(req: Request) {
  const denied=await requireApiAccess(req); if(denied)return denied;
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
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  if(body.appId!==undefined&&!isUuid(body.appId))return NextResponse.json({error:"Valid app UUID required."},{status:400});
  if([body.description,body.change,body.name].some(value=>value!==undefined&&typeof value!=="string"))return NextResponse.json({error:"App descriptions, names and changes must be strings."},{status:400});
  try {
  if (body.action === "create") {
    const description = (body.description ?? "").slice(0, 4000);
    if (!description.trim()) return NextResponse.json({ error: "description is required" }, { status: 400 });
    const app = await createApp(description, { name: body.name, keys: body.keys, modelId: body.modelId });
    return NextResponse.json({ app }, { status: 201 });
  }

  if (body.action === "iterate") {
    if (!body.appId) return NextResponse.json({ error: "appId is required" }, { status: 400 });
    const change = (body.change ?? "").slice(0, 4000);
    if (!change.trim()) return NextResponse.json({ error: "change is required" }, { status: 400 });
    const version = await iterateApp(body.appId, change, { keys: body.keys, modelId: body.modelId });
    if (!version) return NextResponse.json({ error: "app not found" }, { status: 404 });
    return NextResponse.json({ version }, { status: 201 });
  }

  if (body.action === "get") {
    if (!body.appId) return NextResponse.json({ error: "appId is required" }, { status: 400 });
    const app = await getApp(body.appId);
    if (!app) return NextResponse.json({ error: "app not found" }, { status: 404 });
    return NextResponse.json({ app });
  }

  if (body.action === "delete") {
    if (!body.appId) return NextResponse.json({ error: "appId is required" }, { status: 400 });
    return NextResponse.json({ removed: await deleteApp(body.appId) });
  }

  return NextResponse.json({ error: "unknown action (create|iterate|get|delete)" }, { status: 400 });
  }catch{return NextResponse.json({error:"App operation not acknowledged. Previous versions and data remain available; retry after services recover."},{status:503});}
}
