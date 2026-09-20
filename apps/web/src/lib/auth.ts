import { cookies } from "next/headers";
import { getSessionUser, SESSION_COOKIE } from "@waveyard/auth";

export async function currentUser() {
  const cookieStore = await cookies();
  return getSessionUser(cookieStore.get(SESSION_COOKIE)?.value);
}

export async function requireUser() {
  const user = await currentUser();
  if (!user) throw new Response("Authentication required.", { status: 401 });
  return user;
}
