// Owner preferences & boundaries — the workspace's standing-guidance memory.
//
// "Maintaining memory when told so, and constantly referring back to those
// preferences" — this is the store every AI surface draws from. The owner
// (or an assistant acting on an explicit "remember…") files preferences,
// boundaries, and goals; the Orchestrator injects them into every relay
// envelope (classification-filtered) and the Archive Assistant carries them
// in its system prompt.
//
// Classification semantics (who may be told this preference):
//   public   → any participant, including external-trust AIs
//   internal → internal-trust participants only
//   private  → never leaves the owner (human participants only)
//
// House pattern: Postgres when available, in-memory fallback otherwise.

import { db } from "@/db";
import { ownerPreferences } from "@/db/schema";
import { desc, eq, sql } from "drizzle-orm";

export type PreferenceKind = "preference" | "boundary" | "goal";
export type PreferenceClassification = "public" | "internal" | "private";

export interface OwnerPreference {
  id: string;
  content: string;
  kind: PreferenceKind;
  classification: PreferenceClassification;
  source: "owner" | "assistant";
  createdAt: string;
}

export interface PreferenceInput {
  content: string;
  kind?: string;
  classification?: string;
  source?: string;
}

const memoryPreferences = new Map<string, OwnerPreference>();
let dbHealthy = true;
let tableReady = false;

const KINDS: PreferenceKind[] = ["preference", "boundary", "goal"];
const CLASSIFICATIONS: PreferenceClassification[] = ["public", "internal", "private"];

function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function normKind(kind: string | null | undefined): PreferenceKind {
  const v = String(kind ?? "").toLowerCase().trim();
  return (KINDS as string[]).includes(v) ? (v as PreferenceKind) : "preference";
}

function normClassification(c: string | null | undefined): PreferenceClassification {
  const v = String(c ?? "").toLowerCase().trim();
  return (CLASSIFICATIONS as string[]).includes(v) ? (v as PreferenceClassification) : "internal";
}

async function ensureTables(): Promise<void> {
  if (tableReady) return;
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "owner_preferences" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "content" text NOT NULL,
        "kind" text DEFAULT 'preference' NOT NULL,
        "classification" text DEFAULT 'internal' NOT NULL,
        "source" text DEFAULT 'owner' NOT NULL,
        "created_at" timestamp DEFAULT now() NOT NULL
      );
    `);
    tableReady = true;
    dbHealthy = true;
  } catch {
    dbHealthy = false;
  }
}

export async function listPreferences(): Promise<OwnerPreference[]> {
  try {
    await ensureTables();
    if (dbHealthy) {
      const rows = await db.select().from(ownerPreferences).orderBy(desc(ownerPreferences.createdAt)).limit(200);
      return rows.map((r) => ({
        id: r.id,
        content: r.content,
        kind: normKind(r.kind),
        classification: normClassification(r.classification),
        source: r.source === "assistant" ? "assistant" : "owner",
        createdAt: new Date(r.createdAt ?? new Date()).toISOString(),
      }));
    }
  } catch {
    dbHealthy = false;
  }
  return [...memoryPreferences.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export async function addPreference(input: PreferenceInput): Promise<OwnerPreference> {
  const content = String(input.content ?? "").trim().slice(0, 2000);
  if (!content) throw new Error("a preference needs content");
  const pref: OwnerPreference = {
    id: newId(),
    content,
    kind: normKind(input.kind),
    classification: normClassification(input.classification),
    source: input.source === "assistant" ? "assistant" : "owner",
    createdAt: new Date().toISOString(),
  };
  try {
    await ensureTables();
    if (dbHealthy) {
      const [row] = await db
        .insert(ownerPreferences)
        .values({ content: pref.content, kind: pref.kind, classification: pref.classification, source: pref.source })
        .returning();
      if (row) pref.id = row.id;
    }
  } catch {
    dbHealthy = false;
  }
  memoryPreferences.set(pref.id, pref);
  return pref;
}

export async function deletePreference(id: string): Promise<boolean> {
  try {
    await ensureTables();
    if (dbHealthy) {
      await db.delete(ownerPreferences).where(eq(ownerPreferences.id, id));
    }
  } catch {
    dbHealthy = false;
  }
  return memoryPreferences.delete(id) || true;
}

function formatPrefs(prefs: OwnerPreference[]): string {
  // boundaries first — they are the "never overstep" contract
  const order: Record<PreferenceKind, number> = { boundary: 0, preference: 1, goal: 2 };
  const lines = prefs
    .slice()
    .sort((a, b) => order[a.kind] - order[b.kind])
    .map((p) => `- [${p.kind}] ${p.content.slice(0, 220)}`);
  return lines.slice(0, 20).join("\n").slice(0, 1600);
}

/** Preferences a given collaboration participant may be told (classification-filtered). */
export async function preferencesBriefFor(target: { kind: string; trust: string }): Promise<string> {
  const prefs = await listPreferences();
  const usable = prefs.filter((p) => {
    if (target.kind === "human") return true; // the owner knows their own guidance
    if (p.classification === "public") return true;
    if (p.classification === "internal") return target.trust === "internal";
    return false; // private never leaves the owner
  });
  return formatPrefs(usable);
}

/** All preferences — for the owner's own assistant surfaces (chat with the owner). */
export async function preferencesBriefAll(): Promise<string> {
  return formatPrefs(await listPreferences());
}
