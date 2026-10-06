import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import {
  AUTOMATION_PARAMETERS,
  MAX_AUTOMATION_POINTS_PER_LANE,
  automationValueIsValid,
  type AutomationParameter,
} from "@/lib/waveyard/types";
import { db } from "@/db";
import {
  remixAutomationPoints,
  remixSessions,
  remixTracks,
} from "@/db/waveyardSchema";
import { requireUser } from "@/lib/waveyard/local-context";
import { requireProjectRole } from "@/lib/waveyard/local-context";

function finite(value: unknown) {
  if (value === null || value === "" || typeof value === "boolean" || typeof value === "object") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const body = await request.json().catch(() => ({}));
    const operation = body.operation === "delete" ? "delete" : body.operation === "upsert" ? "upsert" : null;
    const remixTrackId = typeof body.remixTrackId === "string" ? body.remixTrackId : "";
    const parameter = AUTOMATION_PARAMETERS.includes(body.parameter as AutomationParameter)
      ? body.parameter as AutomationParameter
      : null;
    if (!operation || !remixTrackId || !parameter)
      return NextResponse.json({ error: "A track, volume/pan parameter, and supported automation action are required." }, { status: 400 });
    
    const [remix] = await db.select().from(remixSessions).where(eq(remixSessions.id, id)).limit(1);
    if (!remix) return NextResponse.json({ error: "Remix session not found." }, { status: 404 });
    await requireProjectRole(user.id, remix.projectId, "editor");
    const [track] = await db.select().from(remixTracks).where(eq(remixTracks.id, remixTrackId)).limit(1);
    if (!track || track.remixSessionId !== remix.id)
      return NextResponse.json({ error: "Automation track is outside this remix session." }, { status: 403 });
    const pointId = typeof body.pointId === "string" ? body.pointId : null;
    if (operation === "delete") {
      if (!pointId) return NextResponse.json({ error: "Automation point is required." }, { status: 400 });
      const [point] = await db.select().from(remixAutomationPoints).where(eq(remixAutomationPoints.id, pointId)).limit(1);
      if (!point || point.remixSessionId !== remix.id || point.remixTrackId !== track.id || point.parameter !== parameter)
        return NextResponse.json({ error: "Automation point is outside this remix session." }, { status: 403 });
      await db.transaction(async (tx) => {
        await tx.delete(remixAutomationPoints).where(eq(remixAutomationPoints.id, point.id));
        await tx.update(remixSessions).set({ version: remix.version + 1, updatedAt: new Date() }).where(eq(remixSessions.id, remix.id));
      });
      return NextResponse.json({ operation, removedPointIds: [point.id] });
    }
    const timelineMs = finite(body.timelineMs);
    const value = finite(body.value);
    if (timelineMs === null || !Number.isSafeInteger(timelineMs) || timelineMs < 0 || timelineMs > 86_400_000
      || value === null || !automationValueIsValid(parameter, value))
      return NextResponse.json({ error: "Automation point timing or value is invalid." }, { status: 422 });
    const [identified] = pointId
      ? await db.select().from(remixAutomationPoints).where(eq(remixAutomationPoints.id, pointId)).limit(1)
      : [];
    if (pointId && !identified)
      return NextResponse.json({ error: "Automation point not found." }, { status: 404 });
    if (identified && (identified.remixSessionId !== remix.id || identified.remixTrackId !== track.id || identified.parameter !== parameter))
      return NextResponse.json({ error: "Automation point is outside this remix session." }, { status: 403 });
    const [atTimestamp] = await db.select().from(remixAutomationPoints).where(and(
      eq(remixAutomationPoints.remixTrackId, track.id),
      eq(remixAutomationPoints.parameter, parameter),
      eq(remixAutomationPoints.timelineMs, timelineMs),
    )).limit(1);
    if (!identified && !atTimestamp) {
      const lanePoints = await db.select({ id: remixAutomationPoints.id }).from(remixAutomationPoints).where(and(
        eq(remixAutomationPoints.remixTrackId, track.id),
        eq(remixAutomationPoints.parameter, parameter),
      ));
      if (lanePoints.length >= MAX_AUTOMATION_POINTS_PER_LANE)
        return NextResponse.json({ error: `This automation lane has reached the ${MAX_AUTOMATION_POINTS_PER_LANE}-point limit.` }, { status: 422 });
    }
    const result = await db.transaction(async (tx) => {
      let point;
      const removedPointIds: string[] = [];
      if (atTimestamp && atTimestamp.id !== pointId) {
        const [updated] = await tx.update(remixAutomationPoints).set({ value, updatedAt: new Date() }).where(eq(remixAutomationPoints.id, atTimestamp.id)).returning();
        point = updated;
        if (identified) {
          await tx.delete(remixAutomationPoints).where(eq(remixAutomationPoints.id, identified.id));
          removedPointIds.push(identified.id);
        }
      } else if (identified) {
        const [updated] = await tx.update(remixAutomationPoints).set({ timelineMs, value, updatedAt: new Date() }).where(eq(remixAutomationPoints.id, identified.id)).returning();
        point = updated;
      } else {
        const [created] = await tx.insert(remixAutomationPoints).values({
          remixSessionId: remix.id,
          remixTrackId: track.id,
          parameter,
          timelineMs,
          value,
        }).returning();
        point = created;
      }
      await tx.update(remixSessions).set({ version: remix.version + 1, updatedAt: new Date() }).where(eq(remixSessions.id, remix.id));
      return { point, removedPointIds };
    });
    return NextResponse.json({ operation, point: result.point, removedPointIds: result.removedPointIds });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("automation edit failed", error);
    return NextResponse.json({ error: "Could not apply the automation point edit." }, { status: 500 });
  }
}
