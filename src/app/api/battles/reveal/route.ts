import { db } from "@/db";
import { assistants, models } from "@/db/schema";
import { inArray } from "drizzle-orm";
import { logPrivacyEvent, openReveal } from "@/lib/privacy";
import { apiErrorResponse, validationError } from "@/lib/apiErrors";

export const dynamic = "force-dynamic";

// POST → reveal an EPHEMERAL battle (nothing stored, no Elo).
// Body: { revealToken, winner } → { modelAId, modelBId, names }.
// Blindness is preserved by AES-256-GCM sealed tokens, not by storage.
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const token: string = (body.revealToken ?? "").toString();
    const winner: string = (body.winner ?? "").toString();
    if (!token) return validationError("INVALID_REQUEST", "Reveal token is required.");
    if (!["a", "b", "tie", "both-bad"].includes(winner)) {
      return validationError("INVALID_REQUEST", "Winner is invalid.");
    }
    const seal = openReveal(token);
    if (!seal || !seal.a || !seal.b) {
      return validationError("INVALID_REQUEST", "Reveal token is invalid or expired.");
    }
    if (seal.exp && Date.now() > seal.exp) {
      return validationError("INVALID_REQUEST", "Reveal token has expired.");
    }

    const modelRows = await db.select().from(models).where(inArray(models.id, [seal.a, seal.b]));
    const mName = new Map(modelRows.map((m) => [m.id, m.name]));
    let aLabel: string | null = null;
    let bLabel: string | null = null;
    const aIds = [seal.aa, seal.bb].filter(Boolean) as string[];
    if (aIds.length) {
      const aRows = await db.select().from(assistants).where(inArray(assistants.id, aIds));
      const byId = new Map(aRows.map((a) => [a.id, `${a.avatar} ${a.name}`]));
      aLabel = seal.aa ? (byId.get(seal.aa) ?? null) : null;
      bLabel = seal.bb ? (byId.get(seal.bb) ?? null) : null;
    }
    const nameA = aLabel
      ? `${aLabel} (${mName.get(seal.a) ?? seal.a})`
      : (mName.get(seal.a) ?? seal.a);
    const nameB = bLabel
      ? `${bLabel} (${mName.get(seal.b) ?? seal.b})`
      : (mName.get(seal.b) ?? seal.b);

    await logPrivacyEvent("ephemeral_reveal", `winner=${winner}`);
    return Response.json({
      ephemeral: true,
      modelAId: seal.a,
      modelBId: seal.b,
      assistantAId: seal.aa,
      assistantBId: seal.bb,
      nameA,
      nameB,
      winner,
      elo: null, // ephemeral votes never touch ratings
    });
  } catch (e) {
    console.error(e);
    return apiErrorResponse(e, { code: "REVEAL_FAILED", message: "Unable to reveal battle.", stage: "execution" });
  }
}
