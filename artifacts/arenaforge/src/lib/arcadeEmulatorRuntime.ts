export const EMULATORJS_VERSION = "4.2.3";
export const EMULATORJS_DATA_URL = `https://cdn.emulatorjs.org/${EMULATORJS_VERSION}/data/`;

export const ARCADE_EMULATOR_SYSTEMS = {
  gb: {
    label: "Game Boy / Game Boy Color",
    core: "gb",
    extensions: [".gb", ".gbc"],
  },
  gba: {
    label: "Game Boy Advance",
    core: "gba",
    extensions: [".gba"],
  },
  snes: {
    label: "Super Nintendo",
    core: "snes",
    extensions: [".sfc", ".smc"],
  },
  segaMD: {
    label: "Mega Drive / Genesis",
    core: "segaMD",
    extensions: [".md", ".gen"],
  },
  segaMS: {
    label: "Sega Master System",
    core: "segaMS",
    extensions: [".sms"],
  },
  segaGG: {
    label: "Sega Game Gear",
    core: "segaGG",
    extensions: [".gg"],
  },
  n64: {
    label: "Nintendo 64",
    core: "n64",
    extensions: [".n64", ".z64", ".v64"],
  },
} as const;

export type ArcadeEmulatorSystemId = keyof typeof ARCADE_EMULATOR_SYSTEMS;

export function isArcadeEmulatorSystemId(value: unknown): value is ArcadeEmulatorSystemId {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(ARCADE_EMULATOR_SYSTEMS, value);
}

export function detectArcadeEmulatorSystem(filename: string): ArcadeEmulatorSystemId | null {
  const extension = filename.slice(filename.lastIndexOf(".")).toLowerCase();
  return (Object.entries(ARCADE_EMULATOR_SYSTEMS) as [ArcadeEmulatorSystemId, (typeof ARCADE_EMULATOR_SYSTEMS)[ArcadeEmulatorSystemId]][])
    .find(([, system]) => (system.extensions as readonly string[]).includes(extension))?.[0] ?? null;
}

export function arcadeEmulatorSystemLabel(system: ArcadeEmulatorSystemId): string {
  return ARCADE_EMULATOR_SYSTEMS[system].label;
}

export function arcadeEmulatorGameKey(id: string): number {
  let hash = 2166136261;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) || 1;
}
