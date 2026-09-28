import { NextResponse } from "next/server";
import { z } from "zod";
import { createSession, sessionCookie, verifyPassword } from "@waveyard/auth";
import { getDb, users } from "@waveyard/database";
import { eq, or } from "drizzle-orm";

const bodySchema = z.object({ identity: z.string().trim().min(1).max(254), password: z.string().min(1).max(128) });
export async function POST(request: Request) {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Email or username and password are required." }, { status: 400 });
  const identity = parsed.data.identity.toLowerCase();
  const [user] = await getDb().select().from(users).where(or(eq(users.email, identity), eq(users.username, identity))).limit(1);
  if (!user || !(await verifyPassword(parsed.data.password, user.passwordHash))) return NextResponse.json({ error: "Invalid credentials." }, { status: 401 });
  const session = await createSession(user.id);
  const response = NextResponse.json({ user: { id: user.id, username: user.username, displayName: user.displayName } });
  response.cookies.set(sessionCookie(session.token, session.expiresAt));
  return response;
}
