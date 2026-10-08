/**
 * Library collections — ratings, labels, and smart collections for the
 * HOME (listening library) layer.
 *
 * Modelled on LightCraft's photo-library organisation (ratings, labels,
 * smart collections; github.com/storytold/lightcraft, Apache-2.0),
 * translated to Waveyard's music-library domain and pure-function style:
 * storage-agnostic, side-effect free, one definition of the rules shared by
 * player, session, and API layers (same contract as model.ts). Persistence
 * and UI wiring are additive follow-ups; this module is the vocabulary they
 * will use.
 */

import { z } from "zod";

export const COLLECTIONS_FORMAT = "waveyard-collections-v1" as const;

/** Star rating: 0 (unrated) .. 5. */
export type TrackRating = 0 | 1 | 2 | 3 | 4 | 5;

export function normalizeRating(value: unknown): TrackRating {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : 0;
  return Math.min(5, Math.max(0, n)) as TrackRating;
}

const MAX_LABELS = 32;
const MAX_LABEL_LENGTH = 64;

/**
 * Normalize free-form labels: trim, collapse whitespace, drop empties,
 * dedupe case-insensitively (first spelling wins), cap count and length.
 */
export function normalizeLabels(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const label = item.replace(/\s+/g, " ").trim();
    if (label.length === 0) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(label.length > MAX_LABEL_LENGTH ? label.slice(0, MAX_LABEL_LENGTH) : label);
    if (out.length >= MAX_LABELS) break;
  }
  return out;
}

/** The track view a collection evaluates: id + the fields HOME already tracks. */
export type CollectionTrack = {
  id: string;
  title: string;
  artist: string;
  /** Epoch ms of intake; used by the addedDaysAgo rule. */
  addedAtMs?: number;
  playCount?: number;
  durationSeconds?: number;
  rating?: number;
  labels?: string[];
};

// ---------------------------------------------------------------------------
// Smart collections
// ---------------------------------------------------------------------------

export const SMART_RULE_FIELDS = [
  "title",
  "artist",
  "label",
  "rating",
  "playCount",
  "durationSeconds",
  "addedDaysAgo",
] as const;

export type SmartRuleField = (typeof SMART_RULE_FIELDS)[number];

export const SMART_RULE_OPS = ["is", "contains", ">=", "<="] as const;

export type SmartRuleOp = (typeof SMART_RULE_OPS)[number];

export type SmartRule = {
  field: SmartRuleField;
  op: SmartRuleOp;
  value: string | number;
};

export type SmartCollection = {
  id: string;
  name: string;
  /** "all" = AND across rules, "any" = OR. */
  match: "all" | "any";
  rules: SmartRule[];
};

const SmartRuleSchema = z.object({
  field: z.enum(SMART_RULE_FIELDS),
  op: z.enum(SMART_RULE_OPS),
  value: z.union([z.string(), z.number()]),
});

const SmartCollectionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  match: z.enum(["all", "any"]),
  rules: z.array(SmartRuleSchema),
});

export function serializeSmartCollections(collections: readonly SmartCollection[]): string {
  return JSON.stringify({ format: COLLECTIONS_FORMAT, collections });
}

export function parseSmartCollections(text: string | null | undefined): SmartCollection[] | null {
  if (text === null || text === undefined || text.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const result = z
    .object({ format: z.literal(COLLECTIONS_FORMAT), collections: z.array(SmartCollectionSchema) })
    .safeParse(parsed);
  if (!result.success) return null;
  return result.data.collections;
}

const DAY_MS = 86_400_000;

/** Evaluate one rule against a track. Pure; `nowMs` keeps time explicit. */
export function evaluateRule(track: CollectionTrack, rule: SmartRule, nowMs: number): boolean {
  switch (rule.field) {
    case "title":
    case "artist": {
      const subject = (rule.field === "title" ? track.title : track.artist).toLowerCase();
      const needle = String(rule.value).toLowerCase().trim();
      if (rule.op === "is") return subject === needle;
      if (rule.op === "contains") return needle.length > 0 && subject.includes(needle);
      return false; // numeric ops do not apply to text fields
    }
    case "label": {
      const labels = track.labels ?? [];
      const needle = String(rule.value).toLowerCase().trim();
      if (rule.op === "is") return labels.some((label) => label.toLowerCase() === needle);
      if (rule.op === "contains") {
        return needle.length > 0 && labels.some((label) => label.toLowerCase().includes(needle));
      }
      return false;
    }
    case "rating": {
      const rating = normalizeRating(track.rating);
      if (rule.op === "is") return rating === normalizeRating(rule.value);
      if (rule.op === ">=") return rating >= Number(rule.value);
      if (rule.op === "<=") return rating <= Number(rule.value);
      return false;
    }
    case "playCount":
    case "durationSeconds": {
      const raw = rule.field === "playCount" ? track.playCount : track.durationSeconds;
      if (raw === undefined || raw === null || !Number.isFinite(raw)) return false;
      if (rule.op === "is") return raw === Number(rule.value);
      if (rule.op === ">=") return raw >= Number(rule.value);
      if (rule.op === "<=") return raw <= Number(rule.value);
      return false;
    }
    case "addedDaysAgo": {
      if (track.addedAtMs === undefined || !Number.isFinite(track.addedAtMs)) return false;
      const days = Math.max(0, Math.floor((nowMs - track.addedAtMs) / DAY_MS));
      if (rule.op === ">=") return days >= Number(rule.value);
      if (rule.op === "<=") return days <= Number(rule.value);
      if (rule.op === "is") return days === Number(rule.value);
      return false;
    }
  }
}

/** Evaluate a whole collection: "all" = AND, "any" = OR; no rules = all pass. */
export function evaluateCollection(
  track: CollectionTrack,
  collection: SmartCollection,
  nowMs: number,
): boolean {
  if (collection.rules.length === 0) return true;
  if (collection.match === "any") {
    return collection.rules.some((rule) => evaluateRule(track, rule, nowMs));
  }
  return collection.rules.every((rule) => evaluateRule(track, rule, nowMs));
}

/** Filter a track list through a collection, preserving order. */
export function filterByCollection(
  tracks: readonly CollectionTrack[],
  collection: SmartCollection,
  nowMs: number,
): CollectionTrack[] {
  return tracks.filter((track) => evaluateCollection(track, collection, nowMs));
}

/** Group tracks by their collection membership (a track may appear in many). */
export function groupByCollections(
  tracks: readonly CollectionTrack[],
  collections: readonly SmartCollection[],
  nowMs: number,
): Record<string, CollectionTrack[]> {
  const groups: Record<string, CollectionTrack[]> = {};
  for (const collection of collections) {
    groups[collection.id] = filterByCollection(tracks, collection, nowMs);
  }
  return groups;
}
