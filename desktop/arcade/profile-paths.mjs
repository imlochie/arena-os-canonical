import { createHash } from "node:crypto";
import path from "node:path";

export function nativeProfileDirectory(root, gameId, scope = "default") {
  if (typeof gameId !== "string" || !gameId || !/^(?:default|mod-[a-f0-9-]{36})$/.test(scope))
    throw new Error("Invalid isolated native profile identity.");
  const namespace = createHash("sha256").update(gameId).digest("hex").slice(0, 32);
  return path.join(root, "profiles", namespace, scope);
}
