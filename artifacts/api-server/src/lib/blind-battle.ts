/** Public execution status must not disclose a fighter before a vote. */
export function blindRuntime(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const runtime = value as Record<string, unknown>;
  // An allowlist also removes identity hidden inside fallbackFrom, free-form
  // provider errors, requestedModelId, notes, and backend/via labels.
  return {
    runtimeLevel: runtime.runtimeLevel,
    ms: runtime.ms,
    latencyMs: runtime.latencyMs,
    firstTokenMs: runtime.firstTokenMs,
    fallback: runtime.fallback,
    ...(runtime.fallback ? { fallbackReason: "Requested execution unavailable" } : {}),
  };
}

/**
 * One response boundary covers creation, history, follow-ups, shared pages,
 * project overviews, and SSE. Full diagnostics remain in the database and
 * become public only after the battle has a winner.
 */
export function publicBattlePayload(value: unknown, forceBlind = false): any {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(item => publicBattlePayload(item, forceBlind));
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const battleRecord = "modelAId" in record && "modelBId" in record && "winner" in record;
  const blind = forceBlind || (battleRecord && !record.winner);
  return Object.fromEntries(Object.entries(record).map(([key, item]) => {
    if (blind && (key === "runtimeA" || key === "runtimeB")) return [key, blindRuntime(item)];
    if (blind && (key === "modelAId" || key === "modelBId")) return [key, "???"];
    if (blind && (key === "assistantAId" || key === "assistantBId")) return [key, null];
    if (blind && (key === "viaA" || key === "viaB")) return [key, "identity-hidden-until-vote"];
    return [key, publicBattlePayload(item, blind)];
  }));
}
