import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { projects } from "@/db/waveyardSchema";
import { requireUser } from "@/lib/waveyard/local-context";
import { listStudioProjects } from "@/lib/waveyard/library/service";

const createSchema = z.object({ title: z.string().trim().min(1).max(160), description: z.string().trim().max(4000).optional(), genre: z.string().trim().max(80).optional(), licenseCode: z.string().trim().max(80).optional() });
export async function GET() {
  try {
    const user = await requireUser();
    // Single-owner local app: no project_members table — the local owner owns
    // every project, so the role is always "owner".
    // Studio listing: library container projects (kind='library', created by
    // "add music") are implementation details of listening tracks and stay
    // out of this list — they remain reachable directly by id ("Open in
    // Studio" from the library player).
    const rows = await listStudioProjects(user.id);
    return NextResponse.json({ projects: rows.map((row) => ({ ...row, role: "owner" })) });
  } catch (error) { if (error instanceof Response) return error; throw error; }
}
export async function POST(request: Request) {
  try {
    const user = await requireUser();
    const parsed = createSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "A project title is required." }, { status: 400 });
    
    const [project] = await db.insert(projects).values({ ownerId: user.id, title: parsed.data.title, description: parsed.data.description ?? "", genre: parsed.data.genre || null, licenseCode: parsed.data.licenseCode || "all-rights-reserved" }).returning();
    return NextResponse.json({ project }, { status: 201 });
  } catch (error) { if (error instanceof Response) return error; throw error; }
}
