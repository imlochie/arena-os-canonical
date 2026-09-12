import { db } from "@/db";
import { artifacts, projectMemory, projects } from "@/db/schema";
import { desc, eq } from "drizzle-orm";

// Server-only: builds the project memory block injected into Council /
// Collab / Battle prompts so sessions build on established knowledge.

export interface ProjectContext {
  project: { id: string; name: string; emoji: string } | null;
  memoryBlock: string;
  counts: { facts: number; decisions: number; openQuestions: number; artifacts: number };
}

const KIND_LABEL: Record<string, string> = {
  fact: "Facts",
  decision: "Decisions",
  preference: "Preferences",
  open_question: "Open questions",
  rejected_idea: "Rejected ideas",
  source: "Sources",
};

export async function getProjectContext(projectId?: string | null): Promise<ProjectContext> {
  const empty: ProjectContext = {
    project: null,
    memoryBlock: "",
    counts: { facts: 0, decisions: 0, openQuestions: 0, artifacts: 0 },
  };
  if (!projectId) return empty;
  try {
    const [p] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
    if (!p) return empty;
    const mem = await db
      .select()
      .from(projectMemory)
      .where(eq(projectMemory.projectId, projectId))
      .orderBy(desc(projectMemory.createdAt))
      .limit(60);
    const arts = await db
      .select()
      .from(artifacts)
      .where(eq(artifacts.projectId, projectId))
      .orderBy(desc(artifacts.createdAt))
      .limit(12);

    const byKind = new Map<string, string[]>();
    for (const m of mem) {
      const list = byKind.get(m.kind) ?? [];
      if (list.length < 10) list.push(m.content.slice(0, 400));
      byKind.set(m.kind, list);
    }
    const lines: string[] = [];
    lines.push(`PROJECT: ${p.emoji} ${p.name}`);
    if (p.description) lines.push(`Brief: ${p.description.slice(0, 300)}`);
    for (const [kind, items] of byKind) {
      if (!items.length) continue;
      lines.push(`\n${KIND_LABEL[kind] ?? kind}:`);
      for (const it of items) lines.push(`- ${it}`);
    }
    if (arts.length) {
      lines.push(`\nPrior artifacts (titles + summaries):`);
      for (const a of arts) {
        lines.push(`- [${a.kind}] ${a.title}: ${a.body.slice(0, 220).replace(/\n/g, " ")}`);
      }
    }
    const block =
      mem.length || arts.length
        ? `Here is what this project has already established. Build on it — and challenge it where the new material suggests it is wrong:\n\n${lines.join("\n").slice(0, 6000)}`
        : "";
    return {
      project: { id: p.id, name: p.name, emoji: p.emoji },
      memoryBlock: block,
      counts: {
        facts: byKind.get("fact")?.length ?? 0,
        decisions: byKind.get("decision")?.length ?? 0,
        openQuestions: byKind.get("open_question")?.length ?? 0,
        artifacts: arts.length,
      },
    };
  } catch {
    return empty;
  }
}

export function withProjectContext(base: string, ctx: ProjectContext): string {
  if (!ctx.memoryBlock) return base;
  return `${ctx.memoryBlock}\n\n---\n\nNew material / instruction:\n${base}`;
}
