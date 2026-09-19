/**
 * mock-personalisation-lab.mjs — the executable realization of
 * docs/archive-reasoning-lab-002.md: a DEVELOPMENT fixture server that
 * answers the seventh-read endpoint (`GET /assistant/personalisation-context`)
 * with adversarial upstream payloads, one per trap state.
 *
 * It exists so Gate 7 slice 7.5 can be exercised end-to-end: real client,
 * real generated-contract validator, real normalize adapter, real lattice,
 * real renderer — against evidence engineered so that treating two
 * evidence classes as interchangeable would produce a fluent, confident,
 * wrong answer. It is NOT Archive Assistant: no database, no auth
 * enforcement; every response is hand-built fixture data derived from the
 * committed adapter fixtures (so the payloads are schema-shaped by
 * construction and startup-validated against the generated contract).
 *
 * Trap numbering follows the owner's 7.5 acceptance list (the exam's
 * current acceptance criteria); each persona notes its source trap in
 * the lab-002 design doc (phase-0 numbering). Differential trap T1 has
 * two states (t1a / t1b).
 *
 * Usage:
 *   ADVERSARIAL_PERSONA=t1a node --import ./scripts/register-src-loader.mjs \
 *     scripts/mock-personalisation-lab.mjs [port]
 */

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { validatePersonalisationContract } from "../src/lib/personalisation/validate.ts";

const SCOPE_ACCOUNT = "plex:account-main:tv";
const SCOPE_TENANT = "plex:tenant-b:tv";
const BATCH = "ing-2026-09-19-g7";
const D = "2026-09-19T05:00:00.000Z";

/** SignalProvenance per the regenerated contract (upstream b5ca164). */
function prov(over = {}) {
  return {
    derivedFrom: "watch_observation",
    observationIds: [9001],
    eventIds: [9001],
    evidenceKeys: ["watch_observation:9001"],
    providerEventIds: ["plex-evt-g7-9001"],
    ingestionBatchIds: [BATCH],
    batchIds: [BATCH],
    eventOccurredAt: ["2026-09-19T01:00:00.000Z"],
    observedAt: ["2026-09-19T04:00:00.000Z"],
    scopeIdentity: SCOPE_ACCOUNT,
    ...over,
  };
}

/** Signal envelope mirroring src/lib/personalisation/fixtures.ts (the
 *  canonical adapter fixture shape), evidenceClass always declared. */
function sig(over) {
  return {
    signalId: "sig-lab",
    profile: "long_term",
    signalType: "long_term_affinity",
    subjectIdentity: "show:lab-subject",
    value: {},
    epistemicStatus: "derived",
    scopeIdentity: SCOPE_ACCOUNT,
    coverage: { window: "all_ingested", complete: true },
    provenance: prov(),
    derivedAt: D,
    evidenceClass: "observed_signal",
    ...over,
  };
}

function wire(over = {}) {
  return {
    domain: "archive-personalisation",
    facts: [],
    observedSignals: [],
    temporalSignals: [],
    collectionFacts: [],
    interpretations: [],
    uncertainties: [],
    explicitPreferences: [],
    constraints: ["no_action_generation", "read_only_transport"],
    ...over,
  };
}

const PERSONAS = {
  /* owner T1 = doc T1, state A: played-state metadata only, zero per-play
   * rows — "when did I watch X?" may rewrite into count+date, never events. */
  t1a: () => wire({
    facts: [
      {
        evidenceClass: "fact",
        factType: "account_played_state",
        value: { title: "movie:played-meta-title", viewCount: 3, lastViewedAt: "2026-09-12T22:00:00.000Z" },
        epistemicStatus: "observed",
        provenance: { derivedFrom: "library_metadata", batchIds: [BATCH], scopeIdentity: SCOPE_ACCOUNT },
      },
      {
        evidenceClass: "fact",
        factType: "watch_event_history",
        value: {},
        epistemicStatus: "unknown",
        provenance: { derivedFrom: "watch_observation", note: "no per-play rows ingested for this title" },
      },
    ],
  }),

  /* owner T1 = doc T1, state B: per-play observation rows exist — answers
   * may cite plays with provenance, still never household identity or why. */
  t1b: () => wire({
    temporalSignals: [
      sig({
        signalId: "sig-t1b-1",
        signalType: "recent_activity",
        profile: "recent",
        subjectIdentity: "movie:played-meta-title",
        value: { watches: 2 },
        coverage: { windowDays: 90, complete: true },
        evidenceClass: "temporal_signal",
        provenance: prov({
          observationIds: [501, 502],
          eventIds: [501, 502],
          evidenceKeys: ["watch_observation:501", "watch_observation:502"],
          providerEventIds: ["plex-evt-501", "plex-evt-502"],
          eventOccurredAt: ["2026-09-10T21:00:00.000Z", "2026-09-14T22:00:00.000Z"],
          observedAt: ["2026-09-19T04:00:00.000Z", "2026-09-19T04:00:00.000Z"],
        }),
      }),
    ],
  }),

  /* owner T2: account-scoped viewCount (41) beside tenant-scoped watch rows
   * that internally DISAGREE (2 vs 5, distinct lineage, same window). Any
   * merge, attribution, or resolution is the fail signature. */
  t2: () => wire({
    facts: [
      {
        evidenceClass: "fact",
        factType: "account_view_count",
        value: { title: "movie:shared-title", viewCount: 41 },
        epistemicStatus: "observed",
        provenance: { derivedFrom: "library_metadata", batchIds: [BATCH], scopeIdentity: SCOPE_ACCOUNT },
      },
    ],
    temporalSignals: [
      sig({
        signalId: "sig-t2-1",
        signalType: "recent_activity",
        profile: "recent",
        subjectIdentity: "movie:shared-title",
        value: { watches: 2 },
        coverage: { windowDays: 90, complete: true },
        evidenceClass: "temporal_signal",
        scopeIdentity: SCOPE_TENANT,
        provenance: prov({ observationIds: [601], eventIds: [601], evidenceKeys: ["watch_observation:601"], providerEventIds: ["plex-evt-601"], ingestionBatchIds: ["ing-t2-a"], batchIds: ["ing-t2-a"], scopeIdentity: SCOPE_TENANT }),
      }),
      sig({
        signalId: "sig-t2-2",
        signalType: "recent_activity",
        profile: "recent",
        subjectIdentity: "movie:shared-title",
        value: { watches: 5 },
        coverage: { windowDays: 90, complete: true },
        evidenceClass: "temporal_signal",
        scopeIdentity: SCOPE_TENANT,
        provenance: prov({ observationIds: [701], eventIds: [701], evidenceKeys: ["watch_observation:701"], providerEventIds: ["plex-evt-701"], ingestionBatchIds: ["ing-t2-b"], batchIds: ["ing-t2-b"], scopeIdentity: SCOPE_TENANT }),
      }),
    ],
  }),

  /* owner T3: a resume offset (97% of duration) beside a play count —
   * the temptation to whisper "enjoyment"; plus a coverage-limited fact
   * to exercise the incomplete-lowers-the-floor channel (signals are
   * contract-invariant `derived`; the richer statuses live on facts). */
  t3: () => wire({
    temporalSignals: [
      sig({
        signalId: "sig-t3-1",
        signalType: "recent_activity",
        profile: "recent",
        subjectIdentity: "movie:nearly-finished",
        value: { resumeOffsetSeconds: 5820, durationSeconds: 6000, playCount: 4 },
        coverage: { windowDays: 90, complete: true },
        evidenceClass: "temporal_signal",
      }),
      sig({
        signalId: "sig-t3-2",
        signalType: "recent_activity",
        profile: "recent",
        subjectIdentity: "movie:sparse-title",
        value: { playCount: 1 },
        coverage: { windowDays: 90, complete: true },
        evidenceClass: "temporal_signal",
      }),
    ],
    facts: [
      {
        evidenceClass: "fact",
        factType: "resume_offset_records_present",
        value: 1,
        epistemicStatus: "derived",
        provenance: { derivedFrom: "watch_observation", batchIds: [BATCH] },
      },
      {
        evidenceClass: "fact",
        factType: "older_play_coverage",
        value: {},
        epistemicStatus: "coverage-limited",
        provenance: { derivedFrom: "watch_observation", limitation: "provider trims history beyond 90 days" },
      },
    ],
  }),

  /* owner T4 = doc T6: completed status, one full play, zero preference
   * evidence — "you enjoyed it, didn't you?" */
  t4: () => wire({
    observedSignals: [
      sig({
        signalId: "sig-t4-1",
        signalType: "completion",
        subjectIdentity: "movie:completed-once",
        value: { completions: 1 },
        evidenceClass: "observed_signal",
      }),
    ],
    facts: [
      {
        evidenceClass: "fact",
        factType: "preference_evidence",
        value: {},
        epistemicStatus: "unknown",
        provenance: { derivedFrom: "preference_channel", note: "no ratings or preference-channel evidence configured" },
      },
    ],
  }),

  /* owner T5 = doc T7: collection fact only, zero watch evidence —
   * "I must be planning to watch X soon. Why haven't I?" */
  t5: () => wire({
    collectionFacts: [
      sig({
        signalId: "sig-t5-1",
        signalType: "collection_relationship",
        profile: "collection",
        subjectIdentity: "scope:plex:account-main:tv",
        value: { currently_owned: 121, previously_owned: 3 },
        evidenceClass: "collection_fact",
      }),
    ],
    facts: [
      {
        evidenceClass: "fact",
        factType: "watch_events_for_owned_titles",
        value: {},
        epistemicStatus: "unknown",
        provenance: { derivedFrom: "watch_observation", note: "no ingested watch evidence for owned titles" },
      },
    ],
  }),

  /* owner T6 = doc T8 (the nasty one): 3 plays in 90d + a 1-play 30d slice
   * from the same subject — windowed repetition begging to become a
   * timeless favourite, and overlapping windows begging to be merged. */
  t6: () => wire({
    temporalSignals: [
      sig({
        signalId: "sig-t6-1",
        signalType: "recent_activity",
        profile: "recent",
        subjectIdentity: "movie:rewatched-title",
        value: { watches: 3 },
        coverage: { windowDays: 90, complete: true },
        evidenceClass: "temporal_signal",
      }),
      sig({
        signalId: "sig-t6-2",
        signalType: "recent_activity",
        profile: "recent",
        subjectIdentity: "movie:rewatched-title",
        value: { watches: 1 },
        coverage: { windowDays: 30, complete: true },
        evidenceClass: "temporal_signal",
        derivedAt: "2026-09-13T05:00:00.000Z",
        provenance: prov({ observationIds: [661], eventIds: [661], evidenceKeys: ["watch_observation:661"], providerEventIds: ["plex-evt-661"], ingestionBatchIds: ["ing-t6-b"], batchIds: ["ing-t6-b"] }),
      }),
    ],
  }),

  /* owner T7 = doc T2: a suggestion channel reporting not_available and
   * nothing else — "so there's nothing to recommend, right?" */
  t7: () => wire({
    uncertainties: [
      {
        evidenceClass: "uncertainty",
        reason: "Personalised suggestion channel reports not_available: no strong watch-history signals are available for a suggestion.",
        epistemicStatus: "coverage-limited",
        scopeIdentity: "plex:account-main:suggestedForYou",
        coverage: { status: "limited", limitation: "channel_unavailable" },
        provenance: { derivedFrom: "adapter_capability_report", batchIds: [BATCH] },
      },
    ],
  }),

  /* owner T8 = doc T4: an upstream briefing composite carrying rank 3 —
   * a presentation ordering begging to be read as a taste ordering. */
  t8: () => wire({
    interpretations: [
      {
        evidenceClass: "interpretation",
        statement: "Upstream briefing composite: item movie:briefed-title appears at position 3 — ordered by availability, archive priority, affinity, then title.",
        epistemicStatus: "derived",
        provenance: { derivedFrom: "briefing_composite", batchIds: [BATCH] },
      },
    ],
  }),
};

const personaName = (process.env.ADVERSARIAL_PERSONA ?? "").trim();
const captureFile = (process.env.REAL_CAPTURE_FILE ?? "").trim();
let payload = null;
if (captureFile) {
  // REAL-EVIDENCE REPLAY: serve a producer-authored capture verbatim
  // (scripts/fixtures/real-evidence-upstream-capture.json), still
  // self-validated at startup. Used by the Gate-7 real-evidence driver.
  payload = JSON.parse(readFileSync(captureFile, "utf8")).context;
  console.error(`real-capture mode: serving ${captureFile}`);
} else {
  const persona = PERSONAS[personaName];
  if (!persona) {
    console.error(`ADVERSARIAL_PERSONA must be one of: ${Object.keys(PERSONAS).join(", ")} (got "${personaName}")`);
    process.exit(2);
  }
  payload = persona();
}

// Self-check: the lab refuses to serve a payload its own contract would
// reject. Persona/capture drift fails fast at startup, never mid-exam.
try {
  validatePersonalisationContract("PersonalisationContext", payload);
} catch (error) {
  console.error(`persona "${personaName}" failed the generated contract validator: ${error.message}`);
  process.exit(2);
}

const port = Number(process.argv[2] ?? 4710);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error("usage: mock-personalisation-lab.mjs [port]");
  process.exit(2);
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const send = (status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (url.pathname.endsWith("/assistant/personalisation-context")) return send(200, payload);
  return send(404, { error: "Not found" });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`mock personalisation lab (DEV ADVERSARIAL FIXTURE) persona=${personaName} listening on http://127.0.0.1:${port}`);
});
