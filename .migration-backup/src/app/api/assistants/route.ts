import { db } from "@/db";
import { assistants } from "@/db/schema";
import { desc } from "drizzle-orm";
import { getModel } from "@/lib/models";

export const dynamic = "force-dynamic";

const STARTERS = [
  {
    name: "Nova — Daily Copilot",
    description: "Encouraging generalist for everyday questions.",
    systemPrompt:
      "You are Nova, a warm, sharp personal copilot. Give clear, actionable answers. Use markdown, keep it skimmable, end with one useful follow-up question.",
    baseModel: "openai",
    temperature: 0.7,
    avatar: "💫",
  },
  {
    name: "Debugger Dan",
    description: "Senior engineer who fixes code fast.",
    systemPrompt:
      "You are Debugger Dan, a senior software engineer. When given code or errors: 1) state the likely cause, 2) show the minimal fix in a code block, 3) explain why, 4) suggest one prevention tip. Be direct, no fluff.",
    baseModel: "deepseek",
    temperature: 0.3,
    avatar: "🪲",
  },
  {
    name: "Muse",
    description: "Creative writing partner with taste.",
    systemPrompt:
      "You are Muse, an award-winning creative writing partner. Write vividly, vary rhythm, avoid clichés. Offer 2 directions when asked for ideas. Never be generic.",
    baseModel: "claude",
    temperature: 0.9,
    avatar: "🎨",
  },
];

export async function GET() {
  try {
    let rows = await db.select().from(assistants).orderBy(desc(assistants.createdAt));
    if (rows.length === 0) {
      await db.insert(assistants).values(STARTERS);
      rows = await db.select().from(assistants).orderBy(desc(assistants.createdAt));
    }
    return Response.json({ assistants: rows });
  } catch (e) {
    console.error(e);
    return Response.json({ assistants: [] });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const name = (body.name ?? "").toString().trim().slice(0, 80);
    const description = (body.description ?? "").toString().slice(0, 300);
    const systemPrompt = (body.systemPrompt ?? "").toString().trim().slice(0, 4000);
    const baseModel = (body.baseModel ?? "openai").toString();
    const temperature = Math.min(2, Math.max(0, Number(body.temperature ?? 0.7)));
    const avatar = (body.avatar ?? "🤖").toString().slice(0, 8);

    if (!name || !systemPrompt) {
      return Response.json({ error: "name and systemPrompt required" }, { status: 400 });
    }
    getModel(baseModel);
    const inserted = await db
      .insert(assistants)
      .values({ name, description, systemPrompt, baseModel, temperature, avatar })
      .returning();
    return Response.json({ assistant: inserted[0] }, { status: 201 });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "create failed" }, { status: 500 });
  }
}
