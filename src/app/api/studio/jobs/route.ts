import { listJobs, publicJobs } from "@/lib/studio/jobs";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 24));
  try {
    const rows = await listJobs(limit);
    return Response.json({ jobs: publicJobs(rows) });
  } catch {
    return Response.json({ jobs: [] });
  }
}
