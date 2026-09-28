// ELO rating helpers (K=32, same spirit as Chatbot Arena)

export const K_FACTOR = 32;
export const BASE_ELO = 1200;

export function expectedScore(eloA: number, eloB: number): number {
  return 1 / (1 + Math.pow(10, (eloB - eloA) / 400));
}

export type BattleOutcome = "a" | "b" | "tie" | "both-bad";

export function newElos(
  eloA: number,
  eloB: number,
  outcome: BattleOutcome
): { a: number; b: number } {
  const ea = expectedScore(eloA, eloB);
  const eb = expectedScore(eloB, eloA);
  let sa = 0.5;
  let sb = 0.5;
  if (outcome === "a") {
    sa = 1;
    sb = 0;
  } else if (outcome === "b") {
    sa = 0;
    sb = 1;
  } else if (outcome === "both-bad") {
    // both lose a little — discourages low quality
    return { a: Math.round(eloA - 4), b: Math.round(eloB - 4) };
  }
  return {
    a: Math.round(eloA + K_FACTOR * (sa - ea)),
    b: Math.round(eloB + K_FACTOR * (sb - eb)),
  };
}

export function winRate(wins: number, battles: number): number {
  if (!battles) return 0;
  return Math.round((wins / battles) * 1000) / 10;
}
