import { clearStemSession } from "@/lib/stems/auth";

export const runtime = "nodejs";

export async function POST() {
  await clearStemSession();
  return Response.json({ ok: true });
}
