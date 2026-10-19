/**
 * Authoritative mixer gain math — the single source of truth shared by the
 * UI, the live transport, and offline render. Pure functions only.
 */

import { clamp, FADER_DB_RANGE, PAN_RANGE, TRIM_DB_RANGE, type ChannelStrip, type MixerState } from "./types";

/** dB → linear gain. */
export function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

/** linear gain → dB (−Infinity for 0). */
export function gainToDb(gain: number): number {
  return gain <= 0 ? -Infinity : 20 * Math.log10(gain);
}

/**
 * Normalized equal-power pan (stereo balance law): unity at center,
 * full hard-left/right at ±1. Matches the live transport's StereoPanner
 * behavior (center = pass-through) so engine and UI never disagree.
 */
export function panGains(pan: number): { left: number; right: number } {
  const p = clamp(pan, PAN_RANGE.min, PAN_RANGE.max);
  if (p === 0) return { left: 1, right: 1 };
  if (p === -1) return { left: 1, right: 0 };
  if (p === 1) return { left: 0, right: 1 };
  const angle = ((p + 1) / 2) * (Math.PI / 2);
  const norm = Math.SQRT1_2; // cos(π/4): normalizes center to unity
  return {
    left: Math.min(1, Math.cos(angle) / norm),
    right: Math.min(1, Math.sin(angle) / norm),
  };
}

/** Is this channel audible given the solo state anywhere in the mixer? */
export function isChannelAudible(strip: ChannelStrip, anySolo: boolean): boolean {
  if (strip.kind === "master") return true;
  return !strip.muted && (!anySolo || strip.solo);
}

/** Any non-master channel soloed? (Buses can solo too.) */
export function anySoloActive(channels: ChannelStrip[]): boolean {
  return channels.some((strip) => strip.kind !== "master" && strip.solo);
}

/**
 * Effective channel gain in dB: trim + fader, or −∞ when muted /
 * cut / not audible under solo. Buses add their own trim/fader on top of
 * the summed member channels (computed by computeGainStages).
 */
export function channelGainDb(strip: ChannelStrip, anySolo: boolean): number {
  if (strip.kind !== "master" && !isChannelAudible(strip, anySolo)) return -Infinity;
  if (strip.mutedInfinity) return -Infinity;
  return clamp(strip.trimDb, TRIM_DB_RANGE.min, TRIM_DB_RANGE.max)
    + clamp(strip.faderDb, FADER_DB_RANGE.min, FADER_DB_RANGE.max);
}

export type GainStages = {
  /** Per-channel post-fader linear gain (stereo pair from pan law). */
  channels: Record<string, { left: number; right: number; audible: boolean; phaseInvert: boolean; monoMonitor: boolean }>;
  /** Topologically ordered bus chain (members first). */
  busOrder: string[];
  master: { left: number; right: number };
};

/**
 * Resolve the full gain structure: every channel's pan-law gains, bus
 * routing order (topological; cycles are rejected), and master gains.
 * Insert chains are NOT gain — they are applied separately by the
 * processing chain (inserts.ts) so bypass/preview stay honest.
 */
export function computeGainStages(state: MixerState): GainStages {
  const byId = new Map(state.channels.map((strip) => [strip.id, strip]));
  const master = state.channels.find((strip) => strip.kind === "master");
  if (master === undefined) throw new Error("Mixer state has no master channel.");

  const anySolo = anySoloActive(state.channels);
  const busOrder = resolveBusOrder(state.channels);

  const channels: GainStages["channels"] = {};
  for (const strip of state.channels) {
    const gainDb = channelGainDb(strip, anySolo);
    const gains = panGains(strip.pan);
    const linear = gainDb === -Infinity ? 0 : dbToGain(gainDb);
    channels[strip.id] = {
      left: linear * gains.left,
      right: linear * gains.right,
      audible: linear > 0,
      phaseInvert: strip.phaseInvert,
      monoMonitor: strip.monoMonitor,
    };
  }

  const masterDb = channelGainDb(master, false);
  const masterGains = panGains(master.pan);
  const masterLinear = masterDb === -Infinity ? 0 : dbToGain(masterDb);
  return {
    channels,
    busOrder,
    master: {
      left: masterLinear * masterGains.left,
      right: masterLinear * masterGains.right,
    },
  };
}

/**
 * Bus routing order: feeders first. A bus that feeds another bus must mix
 * before its target, so the returned list orders every bus BEFORE the bus
 * it routes into. Kahn's algorithm over feeder→receiver edges; throws on
 * cycles (leftover nodes) and unknown bus targets.
 */
export function resolveBusOrder(channels: ChannelStrip[]): string[] {
  const buses = new Map<string, ChannelStrip>();
  for (const strip of channels) {
    if (strip.kind === "bus") buses.set(strip.id, strip);
  }
  const feeders = new Map<string, string[]>();
  const feeds = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  for (const id of buses.keys()) {
    feeders.set(id, []);
    feeds.set(id, []);
    indegree.set(id, 0);
  }
  for (const [id, bus] of buses) {
    if (bus.busId === undefined) continue;
    if (!buses.has(bus.busId))
      throw new Error(`Bus ${id} routes to unknown bus ${bus.busId}.`);
    feeders.get(bus.busId)!.push(id);
    feeds.get(id)!.push(bus.busId);
    // The RECEIVER waits for its feeders, so the target's indegree grows.
    indegree.set(bus.busId, indegree.get(bus.busId)! + 1);
  }
  const ready = [...buses.keys()].filter((id) => indegree.get(id) === 0).sort();
  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const target of feeds.get(id)!) {
      const remaining = indegree.get(target)! - 1;
      indegree.set(target, remaining);
      if (remaining === 0) {
        ready.push(target);
        ready.sort();
      }
    }
  }
  if (order.length !== buses.size)
    throw new Error("Bus routing cycle detected among: " + [...buses.keys()].filter((id) => !order.includes(id)).join(" → "));
  return order;
}

/**
 * Bus assignment for a channel: which bus (or master) receives it.
 * Stems/sources may route to a bus; a bus may route to another bus.
 */
export function resolveChannelTarget(strip: ChannelStrip): string {
  return strip.busId ?? "master";
}
