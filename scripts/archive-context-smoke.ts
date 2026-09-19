/**
 * archive-context-smoke.ts — end-to-end smoke of the Archive Assistant
 * read-only bridge against a LIVE upstream (real Archive Assistant, or the
 * committed development fixture in scripts/mock-archive-assistant.mjs).
 *
 * This is the manual check for "is the information crossing the bridge
 * sufficient?": it runs the real client, the generated-contract runtime
 * validators, and the context normalizer, then prints the same owner-facing
 * digest Arena would reason over.
 *
 * Usage:
 *   npm run smoke:archive -- [--history] [--json] [--lineage <reviewItemId>] [--token <bearer>]
 *
 * Environment (same contract as the app, see .env.example):
 *   ARCHIVE_ASSISTANT_API_URL       required, no localhost fallback
 *   ARCHIVE_ASSISTANT_AUTH_MODE     bearer (default) | local
 *   ARCHIVE_ASSISTANT_OWNER_ID      required in local mode
 *   ARCHIVE_ASSISTANT_BEARER_TOKEN  bearer token to forward (bearer mode),
 *                                   or pass --token
 *
 * Exit codes: 0 ok · 2 configuration problem · 3 upstream/auth/contract failure
 */

import { getArchiveAssistantConfig } from "../src/lib/archive-assistant/config";
import {
  createArchiveAssistantClient,
  type ArchiveAssistantAuth,
} from "../src/lib/archive-assistant/client";
import {
  buildArchiveContext,
  buildFindingLineageFacts,
  summarizeRefresh,
} from "../src/lib/archive-assistant/context";
import { isArchiveAssistantError } from "../src/lib/archive-assistant/errors";
import { ARCHIVE_PROVIDERS, type ArchiveContextFact } from "../src/lib/archive-assistant/types";

type Args = {
  history: boolean;
  json: boolean;
  lineage: number | null;
  token: string | null;
};

function parseArgs(argv: string[]): Args {
  const args: Args = { history: false, json: false, lineage: null, token: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--history") args.history = true;
    else if (a === "--json") args.json = true;
    else if (a === "--token") args.token = argv[++i] ?? null;
    else if (a === "--lineage") {
      const id = Number(argv[++i]);
      if (!Number.isInteger(id) || id < 1) {
        console.error(`--lineage expects a positive integer, got "${argv[i]}"`);
        process.exit(2);
      }
      args.lineage = id;
    } else {
      console.error(`unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

function factLine(index: number, fact: ArchiveContextFact): string {
  const handles: string[] = [];
  if (fact.evidence.refreshId) handles.push(`refreshId=${fact.evidence.refreshId}`);
  if (fact.evidence.observationId != null) handles.push(`observationId=${fact.evidence.observationId}`);
  if (fact.evidence.evidenceKey) handles.push(`evidenceKey=${fact.evidence.evidenceKey}`);
  const classification = fact.classification ? ` (${fact.classification})` : "";
  const cite = handles.length ? `  [${handles.join(" ")}]` : "";
  return `  ${String(index + 1).padStart(2)}. [${fact.source}] ${fact.subjectId}${classification} — ${fact.statement}${cite}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  let config;
  try {
    config = getArchiveAssistantConfig();
  } catch (error) {
    console.error(`✗ configuration: ${(error as Error).message}`);
    process.exit(2);
  }

  let auth: ArchiveAssistantAuth;
  if (config.authMode === "local") {
    auth = { mode: "local", ownerId: config.ownerId ?? "" };
  } else {
    const token = args.token ?? process.env.ARCHIVE_ASSISTANT_BEARER_TOKEN?.trim() ?? null;
    if (!token) {
      console.error(
        "✗ bearer mode needs a token: pass --token <bearer> or set ARCHIVE_ASSISTANT_BEARER_TOKEN.",
      );
      process.exit(2);
    }
    auth = { mode: "bearer", token };
  }

  const client = createArchiveAssistantClient(config, auth);

  try {
    const built = await buildArchiveContext(client, { includeHistory: args.history });

    if (args.json) {
      console.log(JSON.stringify(built, null, 2));
    } else {
      const { context, facts } = built;
      const summary = context.overview.summary;
      const counts = context.workload.counts;
      const rec = context.reconciliation;

      console.log(`Archive Assistant context @ ${context.generatedAt}`);
      console.log(`upstream: ${config.baseUrl} · authMode: ${config.authMode}`);
      console.log("");
      console.log(
        `Overview: ${summary.health} — ${summary.attentionCount} attention · ` +
          `${summary.blockedCount} blocked · ${summary.uncertainCount} uncertain · ` +
          `last scan ${summary.lastScan ?? "never"}`,
      );
      console.log(
        `Workload: ${counts.needs_you} needs_you · ${counts.being_handled} being_handled · ` +
          `${counts.waiting} waiting · ${counts.blocked} blocked · ${counts.uncertain} uncertain · ` +
          `${counts.completed} completed`,
      );
      console.log(
        `Reconciliation: ${rec.matchedCount} matched · ${rec.localOnlyCount} local-only · ` +
          `${rec.plexOnlyCount} provider-only · ${rec.uncertainCount} uncertain · ` +
          `${rec.duplicateCount} duplicates · ${rec.qualityConflictCount} quality conflicts`,
      );

      for (const provider of ARCHIVE_PROVIDERS) {
        const semantics = summarizeRefresh(context.refresh[provider]);
        console.log(`${provider}: ${semantics.interpretation}`);
      }

      if (built.refreshHistory) {
        for (const provider of ARCHIVE_PROVIDERS) {
          const history = built.refreshHistory[provider];
          const ids = (history?.results ?? []).slice(0, 5).map((r) => `${r.refreshId}(${r.status}/${r.snapshotCompleteness}${r.authoritative ? ",auth" : ""})`);
          console.log(`${provider} history (${history?.pagination.total ?? 0}): ${ids.join(" · ") || "—"}`);
        }
      }

      console.log("");
      console.log(`Facts crossing the bridge (${facts.length}${built.factsTruncated ? ", truncated" : ""}):`);
      facts.slice(0, 20).forEach((fact, i) => console.log(factLine(i, fact)));
      if (facts.length > 20) console.log(`  … ${facts.length - 20} more (use --json for the full list)`);
    }

    if (args.lineage !== null) {
      const lineage = await client.getFindingLineage(args.lineage);
      const facts = buildFindingLineageFacts(lineage);
      console.log("");
      console.log(
        `Lineage ${args.lineage}: ${lineage.finding.classification ?? "unclassified"} (${lineage.finding.state}) — ${lineage.finding.title}`,
      );
      console.log(
        `  current observation: ${lineage.currentObservation ? `#${lineage.currentObservation.observationId} @ ${lineage.currentObservation.observedAt}` : "none"}`,
      );
      console.log(
        `  previous observation: ${lineage.previousObservation ? `#${lineage.previousObservation.observationId} (superseded)` : "none"}`,
      );
      console.log(
        `  provider: ${lineage.provider?.refreshId ? `${lineage.provider.provider} refresh ${lineage.provider.refreshId} (snapshot ${lineage.provider.snapshotReference ?? "—"})` : "none"}`,
      );
      facts.forEach((fact, i) => console.log(factLine(i, fact)));
    }

    console.log("");
    console.log("✓ bridge healthy: contract-validated reads, normalized facts, zero mutations attempted.");
  } catch (error) {
    const kind = isArchiveAssistantError(error) ? error.kind : "unexpected";
    console.error(`✗ bridge read failed [${kind}]: ${(error as Error).message}`);
    process.exit(3);
  }
}

await main();
