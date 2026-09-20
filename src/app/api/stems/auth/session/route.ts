import { currentStemUser } from "@/lib/stems/auth";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await currentStemUser();
  return Response.json({ user });
}
