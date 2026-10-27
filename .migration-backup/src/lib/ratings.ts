// Arena-grade rating engine: online Elo + Bradley-Terry MLE + CIs.
// Mirrors LMArena/Chatbot Arena methodology at personal scale:
// - Online Elo (K=32) for live updates after every vote
// - Bradley-Terry maximum-likelihood refit over full vote history
// - 95% confidence intervals (bootstrap for BT, analytic for Elo)
// - Provisional flag below the vote threshold
// - Style-control diagnostics (length bias)

import { expectedScore as eloExpected, K_FACTOR, BASE_ELO } from "./elo";

export { K_FACTOR, BASE_ELO };
export { expectedScore } from "./elo";
export type { BattleOutcome } from "./elo";

export const PROVISIONAL_THRESHOLD = 10; // personal-scale analogue of LMArena's public threshold
export const ANCHOR_ELO = 1200;

export interface Vote {
  a: string;
  b: string;
  outcome: "a" | "b" | "tie";
}

/** A 100-pt gap ≈ 64% expected win rate (same scale as LMArena). */
export function winProbability(eloDiff: number): number {
  return 1 / (1 + Math.pow(10, -eloDiff / 400));
}

export function eloFromWinProb(p: number): number {
  const c = Math.min(0.99, Math.max(0.01, p));
  return Math.round(400 * Math.log10(c / (1 - c)));
}

/** Analytic 95% CI half-width for an Elo estimate given n battles. */
export function eloCIHalfWidth(battles: number): number {
  if (battles <= 0) return 200;
  const hw = Math.round((1.96 * 400) / (2 * Math.sqrt(battles)));
  return Math.max(4, Math.min(200, hw));
}

export function isProvisional(battles: number, threshold = PROVISIONAL_THRESHOLD): boolean {
  return battles < threshold;
}

// ---------- Bradley-Terry (Hunter MM algorithm) ----------

export interface BTResult {
  strengths: Record<string, number>; // p_i, mean-normalized
  elo: Record<string, number>; // anchored so mean = 1200
  iterations: number;
}

/**
 * Fit Bradley-Terry strengths via the MM algorithm (Hunter 2004).
 * Ties count as half a win each. "both-bad" votes should be excluded upstream.
 */
export function fitBradleyTerry(modelIds: string[], votes: Vote[], maxIter = 200, tol = 1e-9): BTResult {
  const ids = [...new Set(modelIds)];
  const n = ids.length;
  const idx = new Map(ids.map((id, i) => [id, i]));
  let p = new Array(n).fill(1 / n);
  const wins = new Array(n).fill(0);
  const pairCounts: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));

  for (const v of votes) {
    const ia = idx.get(v.a);
    const ib = idx.get(v.b);
    if (ia === undefined || ib === undefined || ia === ib) continue;
    pairCounts[ia][ib] += 1;
    pairCounts[ib][ia] += 1;
    if (v.outcome === "a") wins[ia] += 1;
    else if (v.outcome === "b") wins[ib] += 1;
    else {
      wins[ia] += 0.5;
      wins[ib] += 0.5;
    }
  }

  // Regularize: tiny pseudo-count so winless models don't collapse to 0
  for (let i = 0; i < n; i++) wins[i] += 0.01;

  let iterations = 0;
  for (let it = 0; it < maxIter; it++) {
    const next = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      let denom = 0;
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        const nij = pairCounts[i][j];
        if (nij > 0) denom += nij / (p[i] + p[j]);
      }
      next[i] = denom > 0 ? wins[i] / denom : p[i];
    }
    const sum = next.reduce((s, x) => s + x, 0) || 1;
    for (let i = 0; i < n; i++) next[i] /= sum;
    let maxDelta = 0;
    for (let i = 0; i < n; i++) maxDelta = Math.max(maxDelta, Math.abs(next[i] - p[i]));
    p = next;
    iterations = it + 1;
    if (maxDelta < tol) break;
  }

  // Anchor: mean Elo = ANCHOR_ELO (LMArena anchors differently; scale is what matters)
  const logMean = p.reduce((s, x) => s + Math.log(Math.max(x, 1e-12)), 0) / n;
  const strengths: Record<string, number> = {};
  const elo: Record<string, number> = {};
  ids.forEach((id, i) => {
    strengths[id] = p[i];
    elo[id] = Math.round((400 / Math.LN10) * (Math.log(Math.max(p[i], 1e-12)) - logMean) + ANCHOR_ELO);
  });

  return { strengths, elo, iterations };
}

/** Bootstrap 95% CI half-widths for BT Elos. B=100 keeps it fast on small data. */
export function btConfidenceIntervals(
  modelIds: string[],
  votes: Vote[],
  samples = 100
): Record<string, number> {
  const ids = [...new Set(modelIds)];
  if (votes.length < 4) {
    return Object.fromEntries(ids.map((id) => [id, 200]));
  }
  const elos: Record<string, number[]> = Object.fromEntries(ids.map((id) => [id, []]));
  for (let s = 0; s < samples; s++) {
    const resampled: Vote[] = [];
    for (let k = 0; k < votes.length; k++) {
      resampled.push(votes[Math.floor(Math.random() * votes.length)]);
    }
    try {
      const fit = fitBradleyTerry(ids, resampled, 80, 1e-7);
      for (const id of ids) elos[id].push(fit.elo[id] ?? ANCHOR_ELO);
    } catch {
      /* skip failed resample */
    }
  }
  const out: Record<string, number> = {};
  for (const id of ids) {
    const arr = elos[id].sort((a, b) => a - b);
    if (arr.length < 10) {
      out[id] = 200;
      continue;
    }
    const lo = arr[Math.floor(arr.length * 0.025)];
    const hi = arr[Math.ceil(arr.length * 0.975) - 1];
    out[id] = Math.max(4, Math.round((hi - lo) / 2));
  }
  return out;
}

/** Convert battle rows to BT votes, excluding both-bad (LMArena treats it separately too). */
export function toBTVotes(
  rows: { modelAId: string; modelBId: string; winner: string | null }[]
): Vote[] {
  const votes: Vote[] = [];
  for (const r of rows) {
    if (!r.winner || r.winner === "both-bad") continue;
    if (r.winner !== "a" && r.winner !== "b" && r.winner !== "tie") continue;
    votes.push({ a: r.modelAId, b: r.modelBId, outcome: r.winner });
  }
  return votes;
}

export function eloExpectedScore(eloA: number, eloB: number) {
  return eloExpected(eloA, eloB);
}
