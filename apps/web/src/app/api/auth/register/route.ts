import { NextResponse } from "next/server";
import { z } from "zod";
import { createSession, hashPassword, sessionCookie } from "@waveyard/auth";
import { getDb, users } from "@waveyard/database";

const bodySchema = z.object({
  username: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9_-]{2,31}$/),
  displayName: z.string().trim().min(1).max(80),
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(12).max(128),
});

function isInitialModerator(email: string) {
  return (process.env.WAVEYARD_INITIAL_MODERATOR_EMAILS ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
    .includes(email);
}

export async function POST(request: Request) {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Provide a username, display name, valid email, and password of at least 12 characters." }, { status: 400 });
  try {
    const passwordHash = await hashPassword(parsed.data.password);
    const [user] = await getDb().insert(users).values({
      ...parsed.data,
      passwordHash,
      platformRole: isInitialModerator(parsed.data.email) ? "moderator" : "member",
    }).returning();
    const session = await createSession(user.id);
    const response = NextResponse.json({ user: { id: user.id, username: user.username, displayName: user.displayName } }, { status: 201 });
    response.cookies.set(sessionCookie(session.token, session.expiresAt));
    return response;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "23505") return NextResponse.json({ error: "That username or email is already registered." }, { status: 409 });
    console.error("registration failed", error);
    return NextResponse.json({ error: "Account could not be created." }, { status: 500 });
  }
}
