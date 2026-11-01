import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { addArcadeObservation, assessArcadeRuntime, createArcadeManifest, type ArcadeGameDescriptor, type ArcadeManifest } from "./arcadeManifest";
import { currentArcadeHost, findArcadeRuntimeAdapter, identifyArcadeRuntimeAdapter } from "./arcadeRuntimeAdapters";
import { syncArcadeManifests, updateArcadeManifest } from "./arcadeManifestStorage";

export function useArcadeManagement(game: ArcadeGameDescriptor | null) {
  const host = useMemo(currentArcadeHost, []);
  const [manifest, setManifest] = useState<ArcadeManifest | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const resolvedGame = useRef<ArcadeGameDescriptor | null>(null);
  const sameLaunch = (a: ArcadeGameDescriptor | null, b: ArcadeGameDescriptor | null) => !!a && !!b &&
    a.id === b.id && a.scope === b.scope && a.source === b.source && a.format === b.format && a.profile === b.profile && a.saveId === b.saveId;
  const reload = useCallback(async (force = false) => {
    const token = ++generation.current;
    if (!sameLaunch(resolvedGame.current, game)) setManifest(null);
    setError(""); setBusy(true);
    try {
      if (!game) return;
      const adapter = identifyArcadeRuntimeAdapter(game);
      if (!adapter) throw new Error(`No adapter identifies ${game.format}. Install an appropriate verified runtime; this game has not been launched.`);
      const derived = await createArcadeManifest(game, adapter.definition, host);
      if (token !== generation.current) return;
      try {
        const [stored] = await syncArcadeManifests([derived], force);
        if (token === generation.current) { resolvedGame.current = game; setManifest(stored); }
      } catch (cause) {
        if (token !== generation.current) return;
        // Metadata failure must not erase or disable a known legacy game.
        resolvedGame.current = game; setManifest(derived);
        throw cause;
      }
    } catch (cause) { if (token === generation.current) setError(cause instanceof Error ? cause.message : "Game management failed."); }
    finally { if (token === generation.current) setBusy(false); }
  }, [game, host]);
  useEffect(() => { void reload(); return () => { generation.current++; }; }, [reload]);
  const observe = async (stage: "startup" | "gameplay", detail: string) => {
    if (!manifest || busy) return;
    const token = generation.current;
    setBusy(true); setError("");
    try {
      const updated = await updateArcadeManifest(manifest, latest => {
        // Gameplay recording is enabled only after the separate startup
        // checkbox is confirmed; preserve both explicit observations.
        const startup = stage === "gameplay" ? addArcadeObservation(latest, host, "startup", "Player reports observing startup without errors.") : latest;
        return addArcadeObservation(startup, host, stage, detail);
      });
      if (token === generation.current) setManifest(updated);
    } catch (cause) { if (token === generation.current) setError(cause instanceof Error ? cause.message : "Observation was not saved."); }
    finally { if (token === generation.current) setBusy(false); }
  };
  const visible = sameLaunch(resolvedGame.current, game) ? manifest : null;
  const adapter = visible ? findArcadeRuntimeAdapter(visible.runtime.id) : undefined;
  const compatibility = visible ? assessArcadeRuntime(adapter?.definition, visible, host) : null;
  if (compatibility && adapter && game) {
    const bound = identifyArcadeRuntimeAdapter(game);
    if (!adapter.identify(game) || bound?.definition.id !== adapter.definition.id ||
      visible!.runtime.profile !== (game.profile ?? game.format)) {
      compatibility.available = false;
      compatibility.blockers.push("The saved runtime/profile is not bound to this game's current payload. Rebuild metadata for the existing player, or install a matching launch driver.");
    }
  }
  return { manifest: visible, host, error, busy, compatibility, adapter, observe, rebuild: () => reload(true) };
}
