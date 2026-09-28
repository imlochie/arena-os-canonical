import { NextResponse } from "next/server";
import { and, desc, eq, ilike, lt, or } from "drizzle-orm";
import { getDb, projects, users } from "@waveyard/database";
import { parseProjectTags } from "@/lib/publication";

const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 24;
type Cursor = { updatedAt: string; id: string };

function decodeCursor(value: string | null): Cursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (typeof parsed?.updatedAt !== "string" || typeof parsed?.id !== "string")
      return null;
    const updatedAt = new Date(parsed.updatedAt);
    return Number.isNaN(updatedAt.valueOf()) ? null : { updatedAt: updatedAt.toISOString(), id: parsed.id };
  } catch {
    return null;
  }
}

function encodeCursor(cursor: Cursor) {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const query = (url.searchParams.get("q") ?? "").trim().slice(0, 120);
  const genre = (url.searchParams.get("genre") ?? "").trim().slice(0, 80);
  const requestedLimit = Number(url.searchParams.get("limit") ?? DEFAULT_LIMIT);
  const limit = Number.isInteger(requestedLimit)
    ? Math.min(MAX_LIMIT, Math.max(1, requestedLimit))
    : DEFAULT_LIMIT;
  const cursor = decodeCursor(url.searchParams.get("cursor"));
  if (url.searchParams.get("cursor") && !cursor)
    return NextResponse.json({ error: "Invalid discovery cursor." }, { status: 400 });

  const conditions = [
    eq(projects.visibility, "public"),
    eq(projects.publicationStatus, "published"),
    or(eq(projects.moderationStatus, "active"), eq(projects.moderationStatus, "reported")),
  ];
  if (genre) conditions.push(eq(projects.genre, genre));
  if (query) {
    const like = `%${query.replace(/[\\%_]/g, "\\$&")}%`;
    conditions.push(
      or(
        ilike(projects.title, like),
        ilike(projects.description, like),
        ilike(projects.tags, like),
        ilike(users.displayName, like),
      )!,
    );
  }
  if (cursor) {
    const at = new Date(cursor.updatedAt);
    conditions.push(
      or(
        lt(projects.updatedAt, at),
        and(eq(projects.updatedAt, at), lt(projects.id, cursor.id)),
      )!,
    );
  }
  const rows = await getDb()
    .select({
      id: projects.id,
      title: projects.title,
      description: projects.description,
      genre: projects.genre,
      tags: projects.tags,
      licenseCode: projects.licenseCode,
      updatedAt: projects.updatedAt,
      creatorDisplayName: users.displayName,
    })
    .from(projects)
    .innerJoin(users, eq(projects.ownerId, users.id))
    .where(and(...conditions))
    .orderBy(desc(projects.updatedAt), desc(projects.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return NextResponse.json({
    projects: page.map((project) => ({ ...project, tags: parseProjectTags(project.tags) })),
    nextCursor:
      rows.length > limit && last
        ? encodeCursor({ updatedAt: last.updatedAt.toISOString(), id: last.id })
        : null,
  });
}
