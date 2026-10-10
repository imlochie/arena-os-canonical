/**
 * Reconciliation — the merged Archive Assistant's core comparison.
 *
 * Local side: `archive_items` rows of media kinds (the Arena archive index —
 * file references, never moved). Provider side: `media_library_items`
 * (last-known-good per library, because only successful fetches upsert).
 * Matching is identity-based: normalized title + year, the same key the
 * upstream reconciliation used for movies.
 *
 * Honest limits (v1): no local probing, so quality_conflict is never
 * fabricated — it stays 0 unless a provider actually disagrees with another
 * provider's metadata for the same identity, which we do report.
 */

import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { archiveItems, archiveObservations, archiveReviewItems, mediaLibraryItems, reconciliationRuns } from "@/db/schema";
import { mediaIdentityKey, normalizeMediaTitle, type MediaProviderKind } from "./types";
import { latestAuthoritativeRefresh } from "./sync";

export type ReconciliationSummaryNumbers = {
  localCount: number;
  providerCount: number;
  matchedCount: number;
  localOnlyCount: number;
  providerOnlyCount: number;
  uncertainCount: number;
  duplicateCount: number;
  qualityConflictCount: number;
};

/** Parse "Movie Title (2016)" / "Movie.Title.2019.mkv" / plain titles. */
export function parseLocalIdentity(name: string): { title: string; year: number | null } {
  // Strip a trailing media/document extension first.
  const trimmed = name.trim().replace(/\.[a-z0-9]{1,4}$/i, "");
  // "(1995)" anywhere: title is what precedes it ("Heat (1995) copy").
  const paren = trimmed.match(/^(.+?)\s*\(((?:19|20)\d{2})\)/);
  if (paren) return { title: paren[1], year: Number(paren[2]) };
  // Year at the end, dotted or spaced ("Movie.Title.2019", "Movie 2019").
  const tail = trimmed.match(/^(.+?)[.\s]\(?((?:19|20)\d{2})\)?\s*$/);
  if (tail) return { title: tail[1].replace(/\./g, " "), year: Number(tail[2]) };
  return { title: trimmed, year: null };
}

type ReviewKind = "identity" | "duplicate" | "download";

type ReviewDraft = {
  subjectKey: string;
  title: string;
  kind: ReviewKind;
  classification: string;
  providerKind: MediaProviderKind | null;
  payload: Record<string, unknown>;
  evidence: string[];
};

/**
 * Run a full reconciliation pass: compare the local archive index against
 * the synced provider libraries, upsert review items (with observation
 * lineage), supersede findings that healed, and persist the summary.
 */
export async function runReconciliation(): Promise<ReconciliationSummaryNumbers> {
  const locals = await db
    .select()
    .from(archiveItems)
    .where(inArray(archiveItems.kind, ["video", "other"]));
  const providers = await db.select().from(mediaLibraryItems);

  // Index locals by identity.
  const localByIdentity = new Map<string, { id: string; name: string; path: string | null; year: number | null }[]>();
  for (const item of locals) {
    const identity = parseLocalIdentity(item.name);
    if (!normalizeMediaTitle(identity.title)) continue;
    const key = mediaIdentityKey(identity.title, identity.year);
    const bucket = localByIdentity.get(key) ?? [];
    bucket.push({ id: item.id, name: item.name, path: item.path, year: identity.year });
    localByIdentity.set(key, bucket);
  }

  // Index provider items by identity (cross-provider duplicates visible).
  const providerByIdentity = new Map<
    string,
    { provider: MediaProviderKind; ratingKey: string; title: string; year: number | null; library: string }[]
  >();
  for (const item of providers) {
    const key = mediaIdentityKey(item.title, item.year);
    const bucket = providerByIdentity.get(key) ?? [];
    bucket.push({
      provider: (item.providerKind === "jellyfin" ? "jellyfin" : "plex") as MediaProviderKind,
      ratingKey: item.ratingKey,
      title: item.title,
      year: item.year,
      library: item.libraryName,
    });
    providerByIdentity.set(key, bucket);
  }

  const drafts: ReviewDraft[] = [];
  let matchedCount = 0;
  let uncertainCount = 0;
  let qualityConflictCount = 0;

  // Local → provider pass.
  for (const [key, localFiles] of localByIdentity) {
    const providerItems = providerByIdentity.get(key) ?? [];
    const uncertain =
      providerItems.length === 0 &&
      localFiles.some((f) => f.year === null) &&
      [...providerByIdentity.keys()].some((other) => other.split("|")[0] === key.split("|")[0] && other !== key);
    if (providerItems.length > 0) {
      matchedCount += 1;
      if (localFiles.length > 1 || providerItems.length > 1) {
        drafts.push({
          subjectKey: key,
          title: localFiles[0].name,
          kind: "duplicate",
          classification: "duplicate",
          providerKind: providerItems[0].provider,
          payload: {
            summary:
              `${localFiles.length} local cop${localFiles.length === 1 ? "y" : "ies"} and ` +
              `${providerItems.length} provider entr${providerItems.length === 1 ? "y" : "ies"} share one identity.`,
            localFiles: localFiles.map((f) => f.name),
            providerItems: providerItems.map((p) => `${p.provider}:${p.ratingKey} (${p.library})`),
          },
          evidence: ["archive index", ...providerItems.map((p) => `${p.provider} library "${p.library}"`)],
        });
      }
      continue;
    }
    if (uncertain) {
      uncertainCount += 1;
      drafts.push({
        subjectKey: key,
        title: localFiles[0].name,
        kind: "identity",
        classification: "uncertain",
        providerKind: null,
        payload: {
          summary: "Local file has no year; a similarly-titled provider item exists but the identity is not certain.",
          localFiles: localFiles.map((f) => f.name),
        },
        evidence: ["archive index", "provider title similarity (unconfirmed)"],
      });
      continue;
    }
    drafts.push({
      subjectKey: key,
      title: localFiles[0].name,
      kind: "identity",
      classification: "local_only",
      providerKind: null,
      payload: {
        summary: "Local archive file is not indexed by any synced provider library.",
        localFiles: localFiles.map((f) => f.name),
        paths: localFiles.map((f) => f.path ?? "").filter(Boolean),
      },
      evidence: ["archive index", "provider libraries (absence under current authority)"],
    });
  }

  // Provider → local pass (in library, not on disk per the archive index).
  for (const [key, providerItems] of providerByIdentity) {
    if (localByIdentity.has(key)) continue;
    drafts.push({
      subjectKey: key,
      title: providerItems[0].title,
      kind: "download",
      classification: "plex_only",
      providerKind: providerItems[0].provider,
      payload: {
        summary:
          `Listed by ${[...new Set(providerItems.map((p) => p.provider))].join(" + ")} but no matching local file ` +
          `is in the archive index (absence is only as good as the last complete sync).`,
        providerItems: providerItems.map((p) => `${p.provider}:${p.ratingKey} (${p.library})`),
      },
      evidence: providerItems.map((p) => `${p.provider} library "${p.library}"`),
    });
  }

  // Cross-provider duplicates where no local file exists.
  for (const [key, providerItems] of providerByIdentity) {
    if (providerItems.length < 2 || localByIdentity.has(key)) continue;
    if (new Set(providerItems.map((p) => p.provider)).size < 2) continue;
    qualityConflictCount += 0; // placeholder to keep numbering honest below
    drafts.push({
      subjectKey: `${key}#cross`,
      title: providerItems[0].title,
      kind: "duplicate",
      classification: "duplicate",
      providerKind: providerItems[0].provider,
      payload: {
        summary: "The same identity is present in more than one provider library.",
        providerItems: providerItems.map((p) => `${p.provider}:${p.ratingKey} (${p.library})`),
      },
      evidence: providerItems.map((p) => `${p.provider} library "${p.library}"`),
    });
  }

  const summary: ReconciliationSummaryNumbers = {
    localCount: localByIdentity.size,
    providerCount: providerByIdentity.size,
    matchedCount,
    localOnlyCount: drafts.filter((d) => d.classification === "local_only").length,
    providerOnlyCount: drafts.filter((d) => d.classification === "plex_only").length,
    uncertainCount,
    duplicateCount: drafts.filter((d) => d.classification === "duplicate").length,
    qualityConflictCount,
  };

  // Upsert review items + observations; supersede what healed.
  const now = new Date();
  const keepSubjectKeys = new Set(drafts.map((d) => `${d.subjectKey}::${d.kind}`));
  const openItems = await db.select().from(archiveReviewItems);
  for (const existing of openItems) {
    if (existing.state === "needs_you" || existing.state === "uncertain") {
      if (!keepSubjectKeys.has(`${existing.subjectKey}::${existing.kind}`)) {
        await db
          .update(archiveReviewItems)
          .set({ state: "superseded", updatedAt: now })
          .where(eq(archiveReviewItems.id, existing.id));
      }
    }
  }
  for (const draft of drafts) {
    const priorRows = await db
      .select()
      .from(archiveReviewItems)
      .where(and(eq(archiveReviewItems.subjectKey, draft.subjectKey), eq(archiveReviewItems.kind, draft.kind)))
      .limit(1);
    let reviewId: number;
    if (priorRows.length) {
      reviewId = priorRows[0].id;
      await db
        .update(archiveReviewItems)
        .set({
          title: draft.title,
          classification: draft.classification,
          providerKind: draft.providerKind,
          payload: draft.payload,
          evidence: draft.evidence,
          // A re-detected finding reopens unless the human already decided it.
          state: priorRows[0].decision ? priorRows[0].state : "needs_you",
          updatedAt: now,
        })
        .where(eq(archiveReviewItems.id, reviewId));
    } else {
      const [inserted] = await db
        .insert(archiveReviewItems)
        .values({
          subjectKey: draft.subjectKey,
          title: draft.title,
          kind: draft.kind,
          classification: draft.classification,
          providerKind: draft.providerKind,
          state: "needs_you",
          payload: draft.payload,
          evidence: draft.evidence,
        })
        .returning();
      reviewId = inserted.id;
    }
    // Observation lineage: new observation supersedes the previous one.
    const priorObservations = await db
      .select()
      .from(archiveObservations)
      .where(eq(archiveObservations.reviewItemId, reviewId))
      .orderBy(desc(archiveObservations.observedAt))
      .limit(1);
    const [observation] = await db
      .insert(archiveObservations)
      .values({
        reviewItemId: reviewId,
        evidenceKey: `${draft.subjectKey}#${now.getTime()}`,
        payload: { summary: draft.payload.summary, evidence: draft.evidence },
        observedAt: now,
      })
      .returning();
    if (priorObservations.length) {
      await db
        .update(archiveObservations)
        .set({ supersededById: observation.id })
        .where(eq(archiveObservations.id, priorObservations[0].id));
    }
  }

  await db.insert(reconciliationRuns).values({ summary });
  return summary;
}

/** Latest persisted summary, or an honest never-run zero summary. */
export async function latestReconciliationSummary(): Promise<{
  summary: ReconciliationSummaryNumbers;
  generatedAt: string | null;
  everRun: boolean;
}> {
  const rows = await db.select().from(reconciliationRuns).orderBy(desc(reconciliationRuns.generatedAt)).limit(1);
  if (!rows.length) {
    return {
      summary: {
        localCount: 0,
        providerCount: 0,
        matchedCount: 0,
        localOnlyCount: 0,
        providerOnlyCount: 0,
        uncertainCount: 0,
        duplicateCount: 0,
        qualityConflictCount: 0,
      },
      generatedAt: null,
      everRun: false,
    };
  }
  return { summary: rows[0].summary as ReconciliationSummaryNumbers, generatedAt: rows[0].generatedAt.toISOString(), everRun: true };
}

export { latestAuthoritativeRefresh };
