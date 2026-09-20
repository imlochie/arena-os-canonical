import { hash } from "bcryptjs";
import { db } from "@/db";
import { arenaUsers } from "@/db/schema";
import { createStemSession } from "@/lib/stems/auth";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const username = String(body.username ?? "").trim().toLowerCase();
    const email = String(body.email ?? "").trim().toLowerCase();
    const displayName = String(body.displayName ?? "").trim().slice(0, 80);
    const password = String(body.password ?? "");
    if (!/^[a-z0-9_-]{3,32}$/.test(username)) return Response.json({ error: "Username must be 3–32 lowercase letters, numbers, underscores, or hyphens." }, { status: 400 });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return Response.json({ error: "A valid email is required." }, { status: 400 });
    if (!displayName) return Response.json({ error: "Display name is required." }, { status: 400 });
    if (password.length < 12) return Response.json({ error: "Use a password of at least 12 characters." }, { status: 400 });
    const [user] = await db.insert(arenaUsers).values({ username, email, displayName, passwordHash: await hash(password, 12) }).returning();
    await createStemSession(user.id);
    return Response.json({ user: { id: user.id, username: user.username, displayName: user.displayName } }, { status: 201 });
  } catch (error) {
    if ((error as { code?: string }).code === "23505") return Response.json({ error: "That username or email is already in use." }, { status: 409 });
    console.error("Stem registration failed", error);
    return Response.json({ error: "Could not create the account." }, { status: 500 });
  }
}
