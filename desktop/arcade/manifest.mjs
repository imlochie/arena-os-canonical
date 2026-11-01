import { createHash } from "node:crypto";
const profileId = id => createHash("sha256").update(id).digest("hex").slice(0, 32);
/** Metadata-only projection of the common Arcade schema. Native payloads and
 * saves never enter browser storage, prompts or the export. */
export function nativeGameManifest(descriptor, state, host) {
  const key = `${descriptor.id}@${descriptor.version}`;
  const profile = "lpac-zero-capabilities-v1";
  const contentVersion = `sha256:${descriptor.sha256}`;
  const runtime = { id: "arena.desktop.windows-lpac", version: "1", profile };
  const manifest = {
    schema: "arena.arcade.game", schemaVersion: 1, id: `native:${descriptor.id}`, title: descriptor.id,
    ownership: "imported-private", trust: "imported-code",
    provenance: { origin: "Pinned desktop native package catalog; original source/licensing travels with the package" },
    license: { status: "declared", details: descriptor.license },
    installedVersion: contentVersion, runtime,
    requirements: [{ capability: "native-lpac-isolation", reason: "A real Windows containment proof is required before execution.", optional: false }],
    launch: { entryRef: `desktop-catalog:${key}`, arguments: descriptor.arguments },
    permissions: { execution: "Windows LPAC plus bounded Job; native confirmation required", network: "none", allowedOrigins: [],
      filesystem: "Read-only managed game/runtime files; separate writable per-game profile and Windows AppContainer storage" },
    locations: { installation: `desktop-private:installed/${key}`, saves: [`desktop-private:profiles/${profileId(descriptor.id)}/default`, `windows-appcontainer:game/${descriptor.id}`], configuration: [`desktop-private:profiles/${profileId(descriptor.id)}/default`] },
    profiles: [{ id: profile, name: "Default isolated native profile", input: "Game-owned native window", audio: "OS audio device; game compatibility must be tested",
      graphics: "Game-owned renderer; acceptance fixture uses SDL software rendering", mods: [] }],
    history: [], sourceRevisionCopies: 0, evidence: [],
  };
  if (state?.phase === "ready") {
    for (const stage of ["downloaded", "installed"]) manifest.evidence.push({
      stage, outcome: "passed", origin: "local-record", at: state.at, hostId: host.id, gameVersion: contentVersion,
      runtimeId: runtime.id, runtimeVersion: runtime.version, profile,
      detail: stage === "downloaded" ? "Pinned archive acquired and SHA-256 verified; may originate from a local file."
        : "Atomic package activation after per-file integrity checks. Installation is not startup/gameplay proof.",
    });
  }
  return manifest;
}
