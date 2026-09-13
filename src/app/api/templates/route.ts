import { standardApiError } from "@/lib/apiErrors";
import { db } from "@/db";
import { promptTemplates } from "@/db/schema";
import { asc, eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

const DEFAULTS = [
  { title: "ELI5 → Expert", prompt: "Explain {topic} like I'm 5 years old, then again like I'm a domain expert. End with 3 bullet takeaways.", category: "general" },
  { title: "Decision helper", prompt: "I'm deciding: {decision}. Give me 3 options with pros/cons, then a clear recommendation with reasoning.", category: "general" },
  { title: "Debug this", prompt: "This code has a bug:\n\n```\n{paste code}\n```\n\nFind the bug, show the minimal fix, explain why it happened, and how to prevent it.", category: "coding" },
  { title: "Function + tests", prompt: "Write a {language} function that {task}. Include time/space complexity, edge cases, and 3 unit tests.", category: "coding" },
  { title: "Rewrite ×3 tones", prompt: "Rewrite this in 3 tones (professional, casual, bold):\n\n\"{text}\"", category: "writing" },
  { title: "Outline → draft", prompt: "First give me a tight outline for: {topic}. Then expand section 1 into a full draft. Ask before continuing.", category: "writing" },
  { title: "Step-by-step reasoner", prompt: "Solve step by step, showing your work and confidence at each step: {problem}", category: "reasoning" },
  { title: "Fermi estimate", prompt: "Give a Fermi estimate for: {question}. Show assumptions, math, and a sanity check.", category: "reasoning" },
  { title: "Socratic tutor", prompt: "Act as a Socratic tutor on {topic}. Never give direct answers — only questions and hints. Start with a diagnostic question.", category: "roleplay" },
  { title: "Mock interview", prompt: "Interview me for a {role} role. Ask one question at a time, score each answer /10, then ask the next.", category: "roleplay" },
];

export async function GET() {
  try {
    let rows = await db.select().from(promptTemplates).orderBy(asc(promptTemplates.createdAt));
    if (rows.length === 0) {
      await db.insert(promptTemplates).values(DEFAULTS.map((d) => ({ ...d, isDefault: true })));
      rows = await db.select().from(promptTemplates).orderBy(asc(promptTemplates.createdAt));
    }
    return Response.json({ templates: rows });
  } catch (e) {
    console.error(e);
    return Response.json({ templates: [] });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const title = (body.title ?? "").toString().trim().slice(0, 80);
    const prompt = (body.prompt ?? "").toString().trim().slice(0, 2000);
    const category = (body.category ?? "general").toString().slice(0, 32);
    if (!title || !prompt) return standardApiError("INVALID_REQUEST", "Title + prompt required.", 400);
    const [row] = await db.insert(promptTemplates).values({ title, prompt, category }).returning();
    return Response.json({ template: row }, { status: 201 });
  } catch (e) {
    console.error(e);
    return standardApiError("API_OPERATION_FAILED", "Create failed.", 500);
  }
}

export async function DELETE(req: Request) {
  try {
    const url = new URL(req.url);
    const id = url.searchParams.get("id");
    if (!id) return standardApiError("INVALID_REQUEST", "Id required.", 400);
    await db.delete(promptTemplates).where(eq(promptTemplates.id, id));
    return Response.json({ ok: true });
  } catch (e) {
    console.error(e);
    return standardApiError("API_OPERATION_FAILED", "Delete failed.", 500);
  }
}
