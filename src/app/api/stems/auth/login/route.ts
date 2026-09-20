import { compare } from "bcryptjs";
import { or, eq } from "drizzle-orm";
import { db } from "@/db";
import { arenaUsers } from "@/db/schema";
import { createStemSession } from "@/lib/stems/auth";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const identity = String(body.identity ?? "").trim().toLowerCase();
    const password = String(body.password ?? "");
    const [user] = await db.select().from(arenaUsers).where(or(eq(arenaUsers.username, identity), eq(arenaUsers.email, identity))).limit(1);
    if (!user || !(await compare(password, user.passwordHash))) return Response.json({ error: "Invalid sign-in details." }, { status: 401 });
    await createStemSession(user.id);
    return Response.json({ user: { id: user.id, username: user.username, displayName: user.displayName } });
  } catch (error) {
    console.error("Stem login failed", error);
    return Response.json({ error: "Could not sign in." }, { status: 500 });
  }
}
