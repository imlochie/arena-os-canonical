import { db } from "@/db";
import { artifacts, cognitiveSessions, councilArtifacts, councilRuns, projects } from "@/db/schema";
import { desc, eq } from "drizzle-orm";
import { generate } from "@/lib/ai";
import { getCognitiveJob } from "@/lib/cognitiveJobs";
import { getModel, textModels } from "@/lib/models";
import { isEphemeralBody, isLocalOnlyBody, logPrivacyEvent } from "@/lib/privacy";
import { getProjectContext, withProjectContext } from "@/lib/projectContext";
import { ensureSeeded } from "@/lib/seed";

export const dynamic = "force-dynamic";
export const maxDuration = 180;

function pickTextModel(raw: string | undefined, fallback: string): string {
  try {
    const m = getModel(raw ?? fallback);
    return m.kind === "text" ? m.id : fallback;
  } catch {
    return fallback;
  }
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 20), 50);
  try {
    const rows = await db.select().from(councilRuns).orderBy(desc(councilRuns.createdAt)).limit(limit);
    return Response.json({ runs: rows });
  } catch (e) {
    console.error(e);
    return Response.json({ runs: [] });
  }
}

// POST → run the Cognitive Council pipeline:
// raw material → perspective A + B (parallel) → cross-critiques (parallel)
// → synthesis → usable artifact. Honors Local Mode + Ephemeral.
export async function POST(req: Request) {
  try {
    await ensureSeeded();
    const body = await req.json();
    const material: string = (body.material ?? "").toString().trim();
    const jobId: string = (body.jobId ?? "second_brain").toString();
    const keys = body.keys;
    const localOnly = isLocalOnlyBody(body);
    const ephemeral = isEphemeralBody(body);
    const genKeys = localOnly ? undefined : keys;

    if (!material) return Response.json({ error: "material required" }, { status: 400 });
    if (material.length > 8000) return Response.json({ error: "material too long" }, { status: 400 });

    const job = getCognitiveJob(jobId);
    const pool = textModels().filter((m) => m.id !== "offline-sage");
    const rand = () => pool[Math.floor(Math.random() * pool.length)].id;
    const modelAId = body.modelAId ? pickTextModel(String(body.modelAId), "openai") : rand();
    let modelBId = body.modelBId ? pickTextModel(String(body.modelBId), "deepseek") : rand();
    if (modelBId === modelAId) modelBId = modelAId === "openai" ? "deepseek" : "openai";
    const synthesisModel = body.synthesisModel
      ? pickTextModel(String(body.synthesisModel), "openai")
      : "openai";

    const projectId = body.projectId ? String(body.projectId) : null;
    const ctx = await getProjectContext(projectId);
    const effectiveMaterial = withProjectContext(material, ctx);

    const started = Date.now();
    const sysA = `You are ${job.roleA.name} (${job.roleA.emoji}) on a Cognitive Council for the job "${job.name}". ${job.roleA.instruction}`;
    const sysB = `You are ${job.roleB.name} (${job.roleB.emoji}) on a Cognitive Council for the job "${job.name}". ${job.roleB.instruction}`;

    // Stage 1: perspectives in parallel
    const [pA, pB] = await Promise.all([
      generate({
        modelId: modelAId,
        messages: [{ role: "user", content: effectiveMaterial }],
        system: sysA,
        temperature: 0.7,
        keys: genKeys,
        localOnly,
      }),
      generate({
        modelId: modelBId,
        messages: [{ role: "user", content: effectiveMaterial }],
        system: sysB,
        temperature: 0.7,
        keys: genKeys,
        localOnly,
      }),
    ]);

    // Stage 2: cross-critiques in parallel (disagreement is the feature)
    const [cA, cB] = await Promise.all([
      generate({
        modelId: modelAId,
        messages: [
          {
            role: "user",
            content: `ORIGINAL MATERIAL:\n${material.slice(0, 3000)}\n\nYOUR PERSPECTIVE (${job.roleA.name}):\n${pA.text.slice(0, 2500)}\n\nRIVAL PERSPECTIVE (${job.roleB.name}):\n${pB.text.slice(0, 2500)}\n\n${job.critiqueInstruction}`,
          },
        ],
        system: sysA,
        temperature: 0.6,
        keys: genKeys,
        localOnly,
      }),
      generate({
        modelId: modelBId,
        messages: [
          {
            role: "user",
            content: `ORIGINAL MATERIAL:\n${material.slice(0, 3000)}\n\nYOUR PERSPECTIVE (${job.roleB.name}):\n${pB.text.slice(0, 2500)}\n\nRIVAL PERSPECTIVE (${job.roleA.name}):\n${pA.text.slice(0, 2500)}\n\n${job.critiqueInstruction}`,
          },
        ],
        system: sysB,
        temperature: 0.6,
        keys: genKeys,
        localOnly,
      }),
    ]);

    // Stage 3: higher-order synthesis
    const synth = await generate({
      modelId: synthesisModel,
      messages: [
        {
          role: "user",
          content: `COGNITIVE JOB: ${job.name}\n\nRAW MATERIAL:\n${material.slice(0, 3000)}\n\n--- ${job.roleA.name} ---\n${pA.text.slice(0, 2200)}\n\n--- ${job.roleB.name} ---\n${pB.text.slice(0, 2200)}\n\n--- ${job.roleA.name}'s critique ---\n${cA.text.slice(0, 1200)}\n\n--- ${job.roleB.name}'s critique ---\n${cB.text.slice(0, 1200)}`,
        },
      ],
      system: job.synthesisInstruction,
      temperature: 0.5,
      keys: genKeys,
      localOnly,
    });

    // Stage 4: usable artifact
    const art = await generate({
      modelId: synthesisModel,
      messages: [
        {
          role: "user",
          content: `Based on this synthesis, produce the artifact.\n\nSYNTHESIS:\n${synth.text.slice(0, 5000)}`,
        },
      ],
      system: job.artifactInstruction,
      temperature: 0.4,
      keys: genKeys,
      localOnly,
    });

    const ms = Date.now() - started;
    const kind = job.artifactKinds[0] ?? "brief";
    const title = `${job.emoji} ${job.name} — ${new Date().toLocaleDateString()} ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;

    if (ephemeral) {
      await logPrivacyEvent("ephemeral_council", `job=${job.id} localOnly=${localOnly}`);
      return Response.json({
        run: {
          id: `ephemeral-${Date.now().toString(36)}`,
          ephemeral: true,
          jobId: job.id,
          material,
          modelAId,
          modelBId,
          synthesisModel,
          roleALabel: `${job.roleA.emoji} ${job.roleA.name}`,
          roleBLabel: `${job.roleB.emoji} ${job.roleB.name}`,
          perspectiveA: pA.text,
          perspectiveB: pB.text,
          critiqueA: cA.text,
          critiqueB: cB.text,
          synthesis: synth.text,
          latencyMs: ms,
          createdAt: new Date().toISOString(),
          localOnly,
        },
        artifact: { id: "eph-artifact", kind, title, body: art.text },
        ms,
        localOnly,
      });
    }

    const [run] = await db
      .insert(councilRuns)
      .values({
        jobId: job.id,
        material,
        modelAId,
        modelBId,
        synthesisModel,
        roleALabel: `${job.roleA.emoji} ${job.roleA.name}`,
        roleBLabel: `${job.roleB.emoji} ${job.roleB.name}`,
        perspectiveA: pA.text,
        perspectiveB: pB.text,
        critiqueA: cA.text,
        critiqueB: cB.text,
        synthesis: synth.text,
        latencyMs: ms,
        projectId,
      })
      .returning();

    const [artifact] = await db
      .insert(councilArtifacts)
      .values({ runId: run.id, kind, title, body: art.text })
      .returning();

    // Promote the execution into the canonical cognitive-session abstraction.
    // Council remains the execution engine; sessions are the reusable work unit.
    const [session] = await db
      .insert(cognitiveSessions)
      .values({
        projectId,
        councilRunId: run.id,
        title: `${job.emoji} ${job.name}`,
        jobId: job.id,
        material,
        modelAId,
        modelBId,
        synthesisModel,
        roleALabel: `${job.roleA.emoji} ${job.roleA.name}`,
        roleBLabel: `${job.roleB.emoji} ${job.roleB.name}`,
        status: "completed",
      })
      .returning();

    // Dual-write to the unified artifact library (connective tissue).
    let unified: typeof artifact | null = null;
    try {
      const [u] = await db
        .insert(artifacts)
        .values({ projectId, kind, title, body: art.text, sourceType: "council", sourceId: run.id })
        .returning();
      unified = u as unknown as typeof artifact;
    } catch {}
    if (projectId) {
      await db.update(projects).set({ updatedAt: new Date() }).where(eq(projects.id, projectId));
    }

    return Response.json({ run: { ...run, localOnly }, session, artifact, unifiedArtifact: unified, ms, localOnly }, { status: 201 });
  } catch (e) {
    console.error("council error", e);
    return Response.json({ error: "council run failed" }, { status: 500 });
  }
}
