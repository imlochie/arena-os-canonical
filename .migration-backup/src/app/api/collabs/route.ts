import { db } from "@/db";
import { collabs, collabContributions } from "@/db/schema";
import { desc } from "drizzle-orm";
import { generate } from "@/lib/ai";
import {
  getStrategy,
  randomCollaborators,
  resolveCollaborator,
  type Collaborator,
  type CollaboratorInput,
} from "@/lib/collab";
import { localCollabDraft, localSynthesis } from "@/lib/localEngine";
import { getModel } from "@/lib/models";
import { isEphemeralBody, isLocalOnlyBody, logPrivacyEvent } from "@/lib/privacy";
import { getProjectContext, withProjectContext } from "@/lib/projectContext";
import { ensureSeeded } from "@/lib/seed";
import { projects } from "@/db/schema";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 20), 50);
  try {
    const rows = await db.select().from(collabs).orderBy(desc(collabs.createdAt)).limit(limit);
    return Response.json({ collabs: rows });
  } catch (e) {
    console.error(e);
    return Response.json({ collabs: [] });
  }
}

export async function POST(req: Request) {
  try {
    await ensureSeeded();
    const body = await req.json();
    const challenge: string = (body.challenge ?? "").toString().trim();
    const category: string = (body.category ?? "general").toString();
    const strategyId: string = (body.strategy ?? "council").toString();
    const synthesisModelRaw: string = (body.synthesisModel ?? "openai").toString();
    const keys = body.keys;
    const localOnly = isLocalOnlyBody(body);
    const ephemeral = isEphemeralBody(body);
    const genKeys = localOnly ? undefined : keys;

    if (!challenge) return Response.json({ error: "challenge required" }, { status: 400 });
    if (challenge.length > 6000) return Response.json({ error: "challenge too long" }, { status: 400 });

    const strategy = getStrategy(strategyId);
    const synthesisModel = (() => {
      try {
        const m = getModel(synthesisModelRaw);
        return m.kind === "text" ? m.id : "openai";
      } catch {
        return "openai";
      }
    })();

    // Resolve 2–4 collaborators
    let inputs: CollaboratorInput[] = Array.isArray(body.collaborators) ? body.collaborators : [];
    if (inputs.length < 2) inputs = randomCollaborators(3);
    inputs = inputs.slice(0, 4);
    const resolved: Collaborator[] = [];
    for (let i = 0; i < inputs.length; i++) {
      const role = strategy.roles[i % strategy.roles.length];
      const c = await resolveCollaborator(inputs[i] ?? {}, role);
      if (c) resolved.push(c);
    }
    // Top up with randoms if some failed
    if (resolved.length < 2) {
      for (const rin of randomCollaborators(3)) {
        if (resolved.length >= 3) break;
        if (resolved.some((r) => r.modelId === rin.id)) continue;
        const c = await resolveCollaborator(rin, strategy.roles[resolved.length % strategy.roles.length]);
        if (c) resolved.push(c);
      }
    }
    if (resolved.length < 2) return Response.json({ error: "could not resolve collaborators" }, { status: 400 });

    const projectId = body.projectId ? String(body.projectId) : null;
    const ctx = await getProjectContext(projectId);
    const effectiveChallenge = withProjectContext(challenge, ctx);
    const started = Date.now();

    // ---- Round 1: parallel drafts (local or cloud) ----
    const drafts = localOnly
      ? resolved.map((c) => ({
          text: localCollabDraft(`${c.emoji} ${c.label}`, c.role, effectiveChallenge, strategy.id),
          via: "local:collab",
          ms: 1,
        }))
      : await Promise.all(
          resolved.map((c) =>
            generate({
              modelId: c.modelId,
              messages: [{ role: "user", content: effectiveChallenge }],
              system: `${c.sys}\n\nSTRATEGY: ${strategy.name}. ${strategy.contributorInstruction}`,
              keys: genKeys,
              localOnly,
            })
          )
        );

    let critiques: { text: string; via: string; ms: number }[] = [];
    if (strategy.rounds === 2) {
      if (localOnly) {
        critiques = resolved.map((c) => ({
          text: `**${c.emoji} ${c.label} — local critique**\n\n- Strongest rival point: the smallest-testable-step framing (kept).\n- Weakness spotted: drafts under-specify “done” — sharpened below.\n- My sharpened position: ${c.role} says ship the minimal version for the top key term first, measure one outcome, then systematize. No cloud was used; all reasoning stayed on-device.`,
          via: "local:critique",
          ms: 1,
        }));
      } else {
        // ---- Round 2 (debate): each collaborator critiques all drafts + sharpens ----
        const digest = resolved
          .map((c, i) => `--- ${c.emoji} ${c.label} (${c.role}) ---\n${drafts[i].text.slice(0, 1800)}`)
          .join("\n\n");
        critiques = await Promise.all(
          resolved.map((c, i) =>
            generate({
              modelId: c.modelId,
              messages: [
                {
                  role: "user",
                  content: `ORIGINAL CHALLENGE:\n${challenge.slice(0, 2500)}\n\nALL ROUND-1 DRAFTS:\n${digest.slice(0, 8000)}\n\nYou are ${c.label} (${c.role}). Critique the OTHER drafts honestly (what's weak, wrong, or missing), steelman the strongest rival point, then sharpen YOUR position in 3-6 sentences. Markdown.`,
                },
              ],
              system: c.sys,
              temperature: 0.7,
              keys: genKeys,
              localOnly,
            })
          )
        );
      }
    }

    // ---- Synthesis: merge everything into one best result ----
    const synth = localOnly
      ? {
          text: localSynthesis(
            strategy.id,
            challenge,
            resolved.map((c, i) => ({ label: `${c.emoji} ${c.label}`, text: drafts[i].text }))
          ),
          via: "local:synthesis",
          ms: 1,
        }
      : await (async () => {
          const material =
            strategy.rounds === 2
              ? resolved
                  .map(
                    (c, i) =>
                      `--- ${c.emoji} ${c.label} (${c.role}) — DRAFT ---\n${drafts[i].text.slice(0, 2200)}\n\n--- ${c.label} — CRITIQUE ---\n${critiques[i].text.slice(0, 1400)}`
                  )
                  .join("\n\n")
              : resolved
                  .map((c, i) => `--- ${c.emoji} ${c.label} (${c.role}) ---\n${drafts[i].text.slice(0, 2600)}`)
                  .join("\n\n");
          return generate({
            modelId: synthesisModel,
            messages: [
              {
                role: "user",
                content: `CHALLENGE (${strategy.name}):\n${challenge.slice(0, 3000)}\n\nCOLLABORATOR MATERIAL:\n${material.slice(0, 11000)}`,
              },
            ],
            system: strategy.synthesisInstruction,
            temperature: 0.5,
            keys: genKeys,
            localOnly,
          });
        })();

    const collabMeta = {
      challenge,
      category,
      strategy: strategy.id,
      collaborators: JSON.stringify(
        resolved.map((c) => ({
          type: c.type,
          id: c.id,
          label: c.label,
          emoji: c.emoji,
          modelId: c.modelId,
          assistantId: c.assistantId ?? null,
          role: c.role,
        }))
      ),
      synthesisModel,
      synthesis: synth.text,
      rounds: strategy.rounds,
      projectId,
    };

    const contribsBase = (collabId: string) => {
      const list: (typeof collabContributions.$inferInsert)[] = [];
      resolved.forEach((c, i) => {
        list.push({
          collabId,
          round: 1,
          contribIndex: i,
          kind: "draft",
          label: `${c.emoji} ${c.label} · ${c.role}`,
          modelId: c.modelId,
          assistantId: c.assistantId ?? null,
          content: drafts[i].text,
          latencyMs: drafts[i].ms,
        });
        if (strategy.rounds === 2) {
          list.push({
            collabId,
            round: 2,
            contribIndex: i,
            kind: "critique",
            label: `${c.emoji} ${c.label} · critique`,
            modelId: c.modelId,
            assistantId: c.assistantId ?? null,
            content: critiques[i].text,
            latencyMs: critiques[i].ms,
          });
        }
      });
      list.push({
        collabId,
        round: strategy.rounds,
        contribIndex: -1,
        kind: "synthesis",
        label: `💎 Synthesis · ${getModel(synthesisModel).name}`,
        modelId: synthesisModel,
        content: synth.text,
        latencyMs: synth.ms,
      });
      return list;
    };

    if (ephemeral) {
      await logPrivacyEvent("ephemeral_collab", `strategy=${strategy.id} localOnly=${localOnly}`);
      const fakeId = `ephemeral-${Date.now().toString(36)}`;
      return Response.json({
        collab: { ...collabMeta, id: fakeId, ephemeral: true, bestContributor: null, createdAt: new Date().toISOString(), localOnly },
        contributions: contribsBase(fakeId).map((c, i) => ({ ...c, id: `eph-${i}` })),
        ms: Date.now() - started,
        localOnly,
      });
    }

    const [row] = await db.insert(collabs).values(collabMeta).returning();
    const contribs = contribsBase(row.id);
    await db.insert(collabContributions).values(contribs);
    if (projectId) {
      await db.update(projects).set({ updatedAt: new Date() }).where(eq(projects.id, projectId));
    }

    return Response.json({
      collab: { ...row, localOnly },
      contributions: contribs.map((c, i) => ({ ...c, id: `new-${i}` })),
      ms: Date.now() - started,
      localOnly,
    });
  } catch (e) {
    console.error("collab error", e);
    return Response.json({ error: "collaboration failed" }, { status: 500 });
  }
}
