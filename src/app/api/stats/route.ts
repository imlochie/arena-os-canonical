import { standardApiError } from "@/lib/apiErrors";
import { db } from "@/db";
import { battles } from "@/db/schema";
import { FREE_MODELS } from "@/lib/models";
import {
  btConfidenceIntervals,
  fitBradleyTerry,
  toBTVotes,
  winProbability,
} from "@/lib/ratings";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const category = (url.searchParams.get("category") ?? "overall").toString();
  try {
    const all = await db.select().from(battles);
    const scoped = category === "overall" ? all : all.filter((b) => b.category === category);
    const voted = scoped.filter((b) => b.winner);
    const ids = FREE_MODELS.map((m) => m.id);

    // ---- Bradley-Terry refit over full vote history ----
    const votes = toBTVotes(voted);
    const bt = fitBradleyTerry(ids, votes);
    const btCI = btConfidenceIntervals(ids, votes, 80);
    const btBoard = [...ids]
      .map((id) => ({
        id,
        btElo: bt.elo[id] ?? 1200,
        ci: btCI[id] ?? 200,
        votes: votes.filter((v) => v.a === id || v.b === id).length,
      }))
      .sort((a, b) => b.btElo - a.btElo);

    // ---- Head-to-head win matrix: matrix[a][b] = P(a beats b) empirical ----
    const matrix: Record<string, Record<string, { wins: number; losses: number; ties: number; total: number; winRate: number | null }>> = {};
    for (const a of ids) {
      matrix[a] = {};
      for (const b of ids) {
        matrix[a][b] = { wins: 0, losses: 0, ties: 0, total: 0, winRate: null };
      }
    }
    for (const v of votes) {
      const cellAB = matrix[v.a]?.[v.b];
      const cellBA = matrix[v.b]?.[v.a];
      if (!cellAB || !cellBA) continue;
      if (v.outcome === "a") {
        cellAB.wins += 1;
        cellBA.losses += 1;
      } else if (v.outcome === "b") {
        cellAB.losses += 1;
        cellBA.wins += 1;
      } else {
        cellAB.ties += 1;
        cellBA.ties += 1;
      }
      cellAB.total += 1;
      cellBA.total += 1;
    }
    for (const a of ids)
      for (const b of ids) {
        const c = matrix[a][b];
        if (c.total > 0) c.winRate = Math.round(((c.wins + 0.5 * c.ties) / c.total) * 1000) / 10;
      }

    // ---- Integrity metrics (LMArena-style transparency) ----
    const aWins = voted.filter((b) => b.winner === "a").length;
    const bWins = voted.filter((b) => b.winner === "b").length;
    const ties = voted.filter((b) => b.winner === "tie").length;
    const bothBad = voted.filter((b) => b.winner === "both-bad").length;
    const decisive = aWins + bWins;
    const positionBias = decisive > 0 ? Math.round((aWins / decisive) * 1000) / 10 : 50; // ~50 = healthy

    // Style control diagnostic: do longer answers win? (length bias check)
    let longerWins = 0;
    let longerDecisive = 0;
    let totalLenDiff = 0;
    for (const b of voted) {
      if (b.winner !== "a" && b.winner !== "b") continue;
      const la = (b.responseA ?? "").length;
      const lb = (b.responseB ?? "").length;
      if (la === lb) continue;
      longerDecisive += 1;
      totalLenDiff += Math.abs(la - lb);
      const longerWon = (la > lb && b.winner === "a") || (lb > la && b.winner === "b");
      if (longerWon) longerWins += 1;
    }
    const lengthBias = longerDecisive > 0 ? Math.round((longerWins / longerDecisive) * 1000) / 10 : 50;

    // Sampling distribution: battles per model + per category
    const perModel: Record<string, number> = Object.fromEntries(ids.map((id) => [id, 0]));
    const perCategory: Record<string, number> = {};
    for (const b of scoped) {
      perModel[b.modelAId] = (perModel[b.modelAId] ?? 0) + 1;
      perModel[b.modelBId] = (perModel[b.modelBId] ?? 0) + 1;
      perCategory[b.category] = (perCategory[b.category] ?? 0) + 1;
    }

    const topBt = btBoard[0]?.btElo ?? 1200;
    return Response.json({
      category,
      totals: { battles: scoped.length, votes: voted.length, btVotes: votes.length, iterations: bt.iterations },
      btBoard: btBoard.map((r) => ({
        ...r,
        expectedVsTop: Math.round(winProbability(r.btElo - topBt) * 1000) / 10,
      })),
      matrix,
      integrity: {
        aWins,
        bWins,
        ties,
        bothBad,
        tieRate: voted.length ? Math.round((ties / voted.length) * 1000) / 10 : 0,
        bothBadRate: voted.length ? Math.round((bothBad / voted.length) * 1000) / 10 : 0,
        positionBiasAWinRate: positionBias,
        positionHealthy: positionBias >= 40 && positionBias <= 60,
        lengthBiasLongerWinRate: lengthBias,
        lengthHealthy: lengthBias < 65,
        avgDecisiveLengthDiff: longerDecisive ? Math.round(totalLenDiff / longerDecisive) : 0,
      },
      sampling: { perModel, perCategory },
    });
  } catch (e) {
    console.error(e);
    return standardApiError("API_OPERATION_FAILED", "Stats failed.", 500);
  }
}
