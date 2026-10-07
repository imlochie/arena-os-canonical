import { isUuid } from "@/lib/api/ids";
import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  projectBuilds,
} from "@/db/waveyardSchema";
import { requireUser } from "@/lib/waveyard/local-context";
import { requireProjectRole } from "@/lib/waveyard/local-context";

function whole(value: unknown, fallback = 0) { const number = Number(value); return Number.isInteger(number) && number >= 0 ? number : fallback; }

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(); const { id: projectId } = await params;
    if (!isUuid(projectId)) return NextResponse.json({ error: "Invalid id parameter" }, { status: 400 });
    await requireProjectRole(user.id, projectId, "editor");
    const body = await request.json().catch(() => ({}));
    const [build] = await db.insert(projectBuilds).values({ projectId, requestedById: user.id, status: "processing", stage: "resolving-sources", requestedSourceCount: whole(body.requestedSourceCount), details: JSON.stringify({ mode: body.mode === "rebuild" ? "rebuild" : "build" }) }).returning();
    return NextResponse.json({ build }, { status: 201 });
  } catch (error) { if (error instanceof Response) return error; throw error; }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(); const { id: projectId } = await params;
    if (!isUuid(projectId)) return NextResponse.json({ error: "Invalid id parameter" }, { status: 400 });
    await requireProjectRole(user.id, projectId, "editor");
    const body = await request.json().catch(() => ({}));
    const buildId = String(body.buildId ?? "");
    const [build] = await db.select().from(projectBuilds).where(eq(projectBuilds.id, buildId)).limit(1);
    if (!build || build.projectId !== projectId) return NextResponse.json({ error: "Build not found." }, { status: 404 });
    const stage = ["resolving-sources", "separating", "understanding", "finding-structure", "building", "ready", "failed"].includes(body.stage) ? body.stage : build.stage;
    const status = ["processing", "complete", "failed"].includes(body.status) ? body.status : build.status;
    const [updated] = await db.update(projectBuilds).set({ stage, status, acceptedSourceCount: whole(body.acceptedSourceCount, build.acceptedSourceCount), failedSourceCount: whole(body.failedSourceCount, build.failedSourceCount), remixSessionId: typeof body.remixSessionId === "string" ? body.remixSessionId : build.remixSessionId, errorMessage: typeof body.errorMessage === "string" ? body.errorMessage.slice(0, 1000) : build.errorMessage, details: body.details && typeof body.details === "object" ? JSON.stringify(body.details) : build.details, updatedAt: new Date() }).where(eq(projectBuilds.id, build.id)).returning();
    return NextResponse.json({ build: updated });
  } catch (error) { if (error instanceof Response) return error; throw error; }
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(); const { id: projectId } = await params;
    if (!isUuid(projectId)) return NextResponse.json({ error: "Invalid id parameter" }, { status: 400 });
    await requireProjectRole(user.id, projectId, "viewer");
    const [build] = await db.select().from(projectBuilds).where(eq(projectBuilds.projectId, projectId)).orderBy(desc(projectBuilds.updatedAt)).limit(1);
    return NextResponse.json({ build: build ?? null });
  } catch (error) { if (error instanceof Response) return error; throw error; }
}
