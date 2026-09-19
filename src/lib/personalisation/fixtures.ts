/**
 * Test fixtures for the Gate-6 personalisation adapter.
 *
 * Factories, not shared literals: each call returns a fresh payload so the
 * deep-frozen output of one test can never leak into the next.
 *
 * The canonical payload is deliberately faithful to the upstream service's
 * class mapping (behavioral-intelligence.ts): recent_activity → temporal
 * signal, collection_relationship → collection fact, affinity types →
 * observed signal. Fixture CONTENT is illustrative; the CONTRACT (generated
 * snapshot) is what the acceptance suite validates against.
 */

export type RecordedCall = { url: string; method: string; headers: Record<string, string> };

const SCOPE_TV = "plex:account-main:tv";
const BATCH = "ing-2026-09-18-01";

function signalEnvelope(over: Record<string, unknown>): Record<string, unknown> {
  return {
    signalId: "sig-1",
    profile: "long_term",
    signalType: "long_term_affinity",
    subjectIdentity: "show:example-show",
    value: { plays: 4 },
    epistemicStatus: "derived",
    scopeIdentity: SCOPE_TV,
    coverage: { window: "all_ingested", complete: true },
    provenance: {
      derivedFrom: "watch_observation",
      eventIds: [101, 102, 103],
      providerEventIds: ["plex-evt-a1", "plex-evt-b2"],
      batchIds: [BATCH],
      scopeIdentity: SCOPE_TV,
    },
    derivedAt: "2026-09-19T05:00:00.000Z",
    ...over,
  };
}

/** Rich canonical payload: every collection populated, every epistemic
 *  status represented, full envelopes (evidenceClass included) on all
 *  signal classes. */
export function canonicalWire() {
  return {
    domain: "archive-personalisation",
    facts: [
      {
        evidenceClass: "fact",
        factType: "total_plays",
        value: 412,
        epistemicStatus: "observed",
        provenance: { derivedFrom: "watch_observation", batchIds: [BATCH] },
      },
      {
        evidenceClass: "fact",
        factType: "unique_titles_watched",
        value: 87,
        epistemicStatus: "derived",
        provenance: { derivedFrom: "watch_observation" },
      },
      {
        evidenceClass: "fact",
        factType: "jellyfin_session_metrics",
        value: {},
        epistemicStatus: "coverage-limited",
        provenance: { derivedFrom: "watch_observation", limitation: "provider_trims_history" },
      },
      {
        evidenceClass: "fact",
        factType: "watchlist_presence",
        value: {},
        epistemicStatus: "unknown",
        provenance: { derivedFrom: "provider_inventory", note: "no watchlist source configured" },
      },
    ],
    observedSignals: [
      signalEnvelope({
        signalId: "sig-obs-1",
        signalType: "long_term_affinity",
        profile: "long_term",
        evidenceClass: "observed_signal",
      }),
      signalEnvelope({
        signalId: "sig-obs-2",
        signalType: "rewatch_affinity",
        profile: "long_term",
        value: { repeats: 2 },
        evidenceClass: "observed_signal",
      }),
    ],
    temporalSignals: [
      signalEnvelope({
        signalId: "sig-tmp-1",
        signalType: "recent_activity",
        profile: "recent",
        value: { playsLast30d: 4, playsLast90d: 7 },
        coverage: { windowDays: 30, complete: true },
        evidenceClass: "temporal_signal",
      }),
    ],
    collectionFacts: [
      signalEnvelope({
        signalId: "sig-col-1",
        signalType: "collection_relationship",
        profile: "collection",
        subjectIdentity: "scope:plex:account-main:tv",
        value: { currently_owned: 121, previously_owned: 3, departure_unconfirmed: 1 },
        evidenceClass: "collection_fact",
      }),
    ],
    interpretations: [
      {
        evidenceClass: "interpretation",
        statement: "Viewing recurs weekly within the ingested window.",
        epistemicStatus: "derived",
        provenance: { derivedFrom: "behavioral_signal:recurring", signalIds: ["sig-tmp-1"] },
      },
    ],
    uncertainties: [
      {
        evidenceClass: "uncertainty",
        reason: "Jellyfin retains only current state; per-play history for that scope is unavailable.",
        epistemicStatus: "coverage-limited",
        scopeIdentity: "jellyfin:account-main:all",
        coverage: { status: "partial", limitation: "provider_plugin_required" },
        provenance: { derivedFrom: "adapter_capability_report" },
      },
    ],
    explicitPreferences: [
      { kind: "subject_block", subjectIdentity: "movie:example", observedAt: "2026-09-10T00:00:00.000Z" },
    ],
    constraints: ["no_action_generation", "read_only_transport"],
  };
}

/** The honest-empty payload: all eight collections present and empty. */
export function emptyWire() {
  return {
    domain: "archive-personalisation",
    facts: [],
    observedSignals: [],
    temporalSignals: [],
    collectionFacts: [],
    interpretations: [],
    uncertainties: [],
    explicitPreferences: [],
    constraints: [],
  };
}

/** Minimal-optionals payload: interpretation and uncertainty carrying only
 *  the required `evidenceClass` — the adapter must not synthesize the
 *  optional statement/reason/epistemicStatus/coverage/provenance fields. */
export function minimalWire() {
  return {
    ...emptyWire(),
    interpretations: [{ evidenceClass: "interpretation" }],
    uncertainties: [{ evidenceClass: "uncertainty" }],
  };
}

/** Build a fetch stub that serves the seventh read and records every call. */
export function makePersonalisationFetchStub(overrides: Record<string, unknown> = {}) {
  const calls: RecordedCall[] = [];
  const routes: Record<string, unknown> = {
    "/assistant/personalisation-context": canonicalWire(),
    ...overrides,
  };

  const stub = async (
    input: unknown,
    init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal },
  ) => {
    const url = String(input);
    const parsed = new URL(url);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(init?.headers ?? {})) headers[k.toLowerCase()] = String(v);
    calls.push({ url, method: init?.method ?? "GET", headers });

    // Routes are matched by path suffix so the stub works with any API base
    // prefix (e.g. https://host/api → /api/assistant/personalisation-context).
    const matchKey = Object.keys(routes).find((key) => parsed.pathname.endsWith(key));
    const payload: unknown = matchKey ? routes[matchKey] : undefined;
    if (payload === undefined) {
      return new Response("not found", { status: 404 });
    }
    return Response.json(payload);
  };

  return { stub: stub as unknown as typeof fetch, calls };
}
