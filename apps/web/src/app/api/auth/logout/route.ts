import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { deleteSession, expiredSessionCookie, SESSION_COOKIE } from "@waveyard/auth";
export async function POST() {
  const jar = await cookies();
  await deleteSession(jar.get(SESSION_COOKIE)?.value);
  const response = NextResponse.json({ ok: true });
  response.cookies.set(expiredSessionCookie());
  return response;
}
