/**
 * -----------------------------------------------------------------------------
 * AUTO-GENERATED FILE — DO NOT EDIT BY HAND.
 *
 * Source of truth : https://github.com/imlochie/SomeSafePortablesoftware/blob/arena/01a0a0d9-somesafeportablesoftware/lib/api-spec/openapi.yaml
 * Upstream ref    : imlochie/SomeSafePortablesoftware@arena/01a0a0d9-somesafeportablesoftware
 *
 * Byte-for-byte reproducible: regenerate whenever the upstream OpenAPI
 * document changes (npm run generate:archive-contract), then commit both
 * generated files together. The --check mode fails if the committed output
 * is stale with respect to the given spec.
 *   npm run generate:archive-contract
 * -----------------------------------------------------------------------------
 */
/**
 * AUTO-GENERATED TypeScript types for the Archive Assistant read-only boundary.
 * Mirrors the OpenAPI component schemas referenced by the six sanctioned
 * read-only operations. Regenerate; never hand-edit.
 */

export type AssistantBriefingItem = {
  rank: number;
  recommendationId: string;
  title: string;
  archivePriority: "critical" | "high" | "medium" | "low" | "info";
  personalAffinity: "high" | "medium" | "low" | "unknown";
  availability: "available" | "blocked" | "uncertain";
  confidence: string;
  reasons: Array<string>;
  blockedReason: string | null;
};

export type AssistantGroup = {
  id: string;
  type: "download" | "integrity" | "rename" | "duplicate" | "identity" | "quality";
  state: "actionable" | "blocked" | "uncertain" | "informational" | "resolved";
  priority: "critical" | "high" | "medium" | "low" | "info";
  confidence: string;
  title: string;
  explanation: string;
  evidence: Array<string>;
  recommendedAction: string;
  underlyingItemIds: Array<number>;
  itemCount: number;
};

export type AssistantOverview = {
  summary: AssistantOverviewSummary;
  attention: Array<AssistantRecommendation>;
  recommendations: Array<AssistantRecommendation>;
  groups: Array<AssistantGroup>;
  blocked: Array<AssistantRecommendation>;
  uncertain: Array<AssistantRecommendation>;
  informational: Array<string>;
  activeWork: {
    scanStatus: string;
    acquisitionJobs: number;
  };
  mediaExperience: MediaExperience;
  discovery: DiscoverySections;
  personalizedBriefing: Array<AssistantBriefingItem>;
};

export type AssistantOverviewSummary = {
  health: "healthy" | "mostly_healthy" | "attention_required";
  attentionCount: number;
  counts: {
    critical: number;
    high: number;
    medium: number;
    low: number;
    info: number;
  };
  blockedCount: number;
  uncertainCount: number;
  lastScan: string | null;
  freshness: string;
};

export type AssistantRecommendation = {
  id: string;
  type: "download" | "integrity" | "rename" | "duplicate" | "identity" | "quality";
  priority: "critical" | "high" | "medium" | "low" | "info";
  confidence: string;
  title: string;
  explanation: string;
  evidence: Array<string>;
  recommendedAction: string;
  state: string;
  reviewItemId: number | null;
  personalContext?: {
    watchState: string;
    lastWatchedAt: string | null;
    playCount: number;
    watchedMinutes: number;
    seriesProgress: number | null;
    isNextEpisode: boolean;
  } | null;
  personalAffinity?: {
    priority: "high" | "medium" | "low" | "unknown";
    basedOn: Array<string>;
  } | null;
};

export type AssistantWorkload = {
  items: Array<AssistantWorkloadItem>;
  counts: {
    needs_you: number;
    being_handled: number;
    waiting: number;
    interesting: number;
    completed: number;
    dismissed: number;
    superseded: number;
    blocked: number;
    uncertain: number;
  };
  generatedAt: string;
};

export type AssistantWorkloadItem = {
  id: string;
  title: string;
  reviewItemId: number | null;
  findingClassification: string | null;
  currentObservationId: number | null;
  provider: string | null;
  refreshId: string | null;
  evidenceKey: string | null;
  observedAt: string | null;
  changeContext: {
    previousObservationId: number;
    previousEvidenceKey: string;
    previousObservedAt: string;
  } | null;
  summary: string;
  state: "needs_you" | "being_handled" | "waiting" | "interesting" | "completed" | "dismissed" | "blocked" | "uncertain";
  needsUserAction: boolean;
  nextStep: string;
  destination: "assistant" | "queue" | "history";
  source: "assistant" | "download" | "review" | "health";
  sourceId: string;
  evidence: Array<string>;
  confidence: string | null;
  lastConfirmedAt: string | null;
  freshness: "fresh" | "recent" | "stale" | "unknown";
};

export type CurrentViewingMomentum = {
  activeSeriesCount: number;
  recentlyWatchedCount: number;
  windowDays: 30;
};

export type DiscoveryItem = {
  id: string;
  title: string;
  provider: "plex" | "jellyfin";
  itemType: "movie" | "show" | "episode" | "unknown";
  releaseDate: string | null;
  personalRelevance: "high" | "medium" | "low" | "unknown";
  reasons: Array<string>;
  evidence: Array<string>;
};

export type DiscoverySection = {
  status: "available" | "limited" | "not_available";
  reason: string | null;
  items: Array<DiscoveryItem>;
};

export type DiscoverySections = {
  upcoming: DiscoverySection;
  recentlyReleased: DiscoverySection;
  trending: DiscoverySection;
  suggestedForYou: DiscoverySection;
};

export type MediaExperience = {
  sourceStatus: "provider_metadata" | "no_synced_provider_data";
  items: Array<MediaExperienceItem>;
  completed: Array<MediaExperienceItem>;
  inProgress: Array<MediaExperienceItem>;
  summary: MediaExperienceSummary;
  currentViewingMomentum: CurrentViewingMomentum;
  watchlist: {
    status: "not_available";
    items: Array<MediaExperienceItem>;
  };
};

export type MediaExperienceItem = {
  key: string;
  provider: "plex" | "jellyfin";
  title: string;
  itemType: "movie" | "show" | "episode" | "unknown";
  year: number | null;
  releaseDate: string | null;
  durationMinutes: number | null;
  status: "completed" | "in_progress" | "unwatched" | "unknown";
  progressPercent: number | null;
  playCount: number;
  lastWatchedAt: string | null;
  watchedMinutes: number;
  seriesTitle: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  seriesProgress: number | null;
  isNextEpisode: boolean;
  evidence: Array<string>;
};

export type MediaExperienceSummary = {
  completedCount: number;
  inProgressCount: number;
  watchedMinutes: number;
  watchedHours: number;
};

export type ProviderRefresh = {
  refreshId: string;
  provider: "plex" | "jellyfin";
  startedAt: string;
  completedAt: string | null;
  status: "syncing" | "synced" | "sync_error";
  snapshotCompleteness: "complete" | "partial" | "unknown";
  itemCount: number | null;
  authoritative: boolean;
  reason: string | null;
  snapshotReference: string | null;
};

export type ProviderRefreshHistory = {
  results: Array<ProviderRefresh>;
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
};

export type ProviderRefreshState = {
  provider: "plex" | "jellyfin";
  lastAttemptedRefresh: ProviderRefresh | null;
  lastSuccessfulRefresh: ProviderRefresh | null;
  currentAuthoritativeRefresh: ProviderRefresh | null;
};

export type ReconciliationFindingLineage = {
  finding: {
    reviewItemId: number;
    subjectKey: string;
    state: string;
    classification: string | null;
    title: string;
    evidenceKey: string | null;
  };
  currentObservation: {
    observationId: number;
    evidenceKey: string;
    observedAt: string;
  } | null;
  provider: {
    provider: string | null;
    refreshId: string | null;
    capturedAt: string | null;
    snapshotReference: string | null;
  } | null;
  previousObservation: {
    observationId: number;
    evidenceKey: string;
    observedAt: string;
  } | null;
};

export type ReconciliationIdentity = ReconciliationTvIdentity | ReconciliationMovieIdentity;

export type ReconciliationLocalItem = {
  fileRecordId: number;
  localMediaIdentityId: number | null;
  path: string;
  relativePath: string;
  volumeId: string | null;
  archiveRoot: string | null;
  mediaType: string | null;
  identity: ReconciliationIdentity | null;
  scanStatus: string;
};

export type ReconciliationMovieIdentity = {
  strategy: "movie_title_year" | "fallback_title_year";
  title: string;
  year: number | null;
};

export type ReconciliationPlexItem = {
  id: number;
  ratingKey: string;
  libraryId: number;
  libraryName: string;
  title: string;
  year: number | null;
  itemType: string;
  identity: ReconciliationIdentity | null;
};

export type ReconciliationQuality = {
  status: "not_compared" | "conflict" | "equivalent_available_metadata";
  differences: Array<"resolution" | "dynamic_range" | "video_codec" | "bitrate" | "audio_codec" | "audio_channels" | "container">;
};

export type ReconciliationReport = {
  summary: ReconciliationSummary;
  pagination: ReportPagination;
  results: Array<ReconciliationResult>;
};

export type ReconciliationResult = {
  classification: "matched" | "local_only" | "plex_only" | "duplicate" | "quality_conflict" | "uncertain";
  matchingStrategy: "tv_show_season_episode" | "movie_title_year" | "fallback_title_year" | "checksum" | "fingerprint" | "semantic_identity" | "ambiguous" | "no_match";
  candidateCount: number;
  local: ReconciliationLocalItem | null;
  plex: ReconciliationPlexItem | null;
  ambiguityCandidates: Array<ReconciliationPlexItem>;
  quality: ReconciliationQuality;
};

export type ReconciliationSummary = {
  localCount: number;
  plexCount: number;
  matchedCount: number;
  localOnlyCount: number;
  plexOnlyCount: number;
  uncertainCount: number;
  duplicateCount: number;
  qualityConflictCount: number;
};

export type ReconciliationTvIdentity = {
  strategy: "tv_show_season_episode";
  show: string;
  season: number;
  episode: number;
  grandparentRatingKey?: string | null;
  parentRatingKey?: string | null;
  title?: string;
  ratingKey?: string;
};

export type ReportPagination = {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};
