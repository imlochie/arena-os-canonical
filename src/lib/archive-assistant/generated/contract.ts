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
 * AUTO-GENERATED machine-readable snapshot of the Archive Assistant read-only
 * OpenAPI subset: the six sanctioned GET operations plus the transitive
 * closure of their component schemas. The runtime validator
 * (../validate.ts) checks every upstream response against this snapshot.
 * Regenerate; never hand-edit.
 */

export const archiveContractMeta = {
  "sourceSpec": "https://github.com/imlochie/SomeSafePortablesoftware/blob/arena/01a0a0d9-somesafeportablesoftware/lib/api-spec/openapi.yaml",
  "sourceRef": "imlochie/SomeSafePortablesoftware@arena/01a0a0d9-somesafeportablesoftware"
};

export const archiveReadOnlyOperations = {
  "getAssistantOverview": {
    "method": "GET",
    "path": "/assistant/overview",
    "response": "AssistantOverview"
  },
  "getAssistantWorkload": {
    "method": "GET",
    "path": "/assistant/workload",
    "response": "AssistantWorkload"
  },
  "getArchiveReconciliation": {
    "method": "GET",
    "path": "/archive/reconciliation",
    "response": "ReconciliationReport",
    "parameters": [
      {
        "name": "page",
        "in": "query",
        "required": false,
        "type": "number",
        "minimum": 1
      },
      {
        "name": "pageSize",
        "in": "query",
        "required": false,
        "type": "number",
        "minimum": 1,
        "maximum": 500
      }
    ]
  },
  "getReconciliationFindingLineage": {
    "method": "GET",
    "path": "/archive/reconciliation/findings/{reviewItemId}/lineage",
    "response": "ReconciliationFindingLineage",
    "parameters": [
      {
        "name": "reviewItemId",
        "in": "path",
        "required": true,
        "type": "number",
        "minimum": 1
      }
    ]
  },
  "getProviderRefreshState": {
    "method": "GET",
    "path": "/provider/refresh",
    "response": "ProviderRefreshState",
    "parameters": [
      {
        "name": "provider",
        "in": "query",
        "required": true,
        "type": "string",
        "enum": [
          "plex",
          "jellyfin"
        ]
      }
    ]
  },
  "listProviderRefreshHistory": {
    "method": "GET",
    "path": "/provider/refresh/history",
    "response": "ProviderRefreshHistory",
    "parameters": [
      {
        "name": "provider",
        "in": "query",
        "required": true,
        "type": "string",
        "enum": [
          "plex",
          "jellyfin"
        ]
      },
      {
        "name": "page",
        "in": "query",
        "required": false,
        "type": "number",
        "minimum": 1
      },
      {
        "name": "pageSize",
        "in": "query",
        "required": false,
        "type": "number",
        "minimum": 1,
        "maximum": 100
      }
    ]
  }
};

export const archiveSchemas = {
  "AssistantBriefingItem": {
    "type": "object",
    "required": [
      "rank",
      "recommendationId",
      "title",
      "archivePriority",
      "personalAffinity",
      "availability",
      "confidence",
      "reasons",
      "blockedReason"
    ],
    "properties": {
      "rank": {
        "type": "number",
        "minimum": 1
      },
      "recommendationId": {
        "type": "string"
      },
      "title": {
        "type": "string"
      },
      "archivePriority": {
        "type": "string",
        "enum": [
          "critical",
          "high",
          "medium",
          "low",
          "info"
        ]
      },
      "personalAffinity": {
        "type": "string",
        "enum": [
          "high",
          "medium",
          "low",
          "unknown"
        ]
      },
      "availability": {
        "type": "string",
        "enum": [
          "available",
          "blocked",
          "uncertain"
        ]
      },
      "confidence": {
        "type": "string"
      },
      "reasons": {
        "type": "array",
        "items": {
          "type": "string"
        }
      },
      "blockedReason": {
        "type": [
          "string",
          "null"
        ]
      }
    }
  },
  "AssistantGroup": {
    "type": "object",
    "required": [
      "id",
      "type",
      "state",
      "priority",
      "confidence",
      "title",
      "explanation",
      "evidence",
      "recommendedAction",
      "underlyingItemIds",
      "itemCount"
    ],
    "properties": {
      "id": {
        "type": "string"
      },
      "type": {
        "type": "string",
        "enum": [
          "download",
          "integrity",
          "rename",
          "duplicate",
          "identity",
          "quality"
        ]
      },
      "state": {
        "type": "string",
        "enum": [
          "actionable",
          "blocked",
          "uncertain",
          "informational",
          "resolved"
        ]
      },
      "priority": {
        "type": "string",
        "enum": [
          "critical",
          "high",
          "medium",
          "low",
          "info"
        ]
      },
      "confidence": {
        "type": "string"
      },
      "title": {
        "type": "string"
      },
      "explanation": {
        "type": "string"
      },
      "evidence": {
        "type": "array",
        "items": {
          "type": "string"
        }
      },
      "recommendedAction": {
        "type": "string"
      },
      "underlyingItemIds": {
        "type": "array",
        "items": {
          "type": "number"
        }
      },
      "itemCount": {
        "type": "number",
        "minimum": 1
      }
    }
  },
  "AssistantOverview": {
    "type": "object",
    "required": [
      "summary",
      "attention",
      "recommendations",
      "groups",
      "blocked",
      "uncertain",
      "informational",
      "activeWork",
      "mediaExperience",
      "discovery",
      "personalizedBriefing"
    ],
    "properties": {
      "summary": {
        "$ref": "#/components/schemas/AssistantOverviewSummary"
      },
      "attention": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/AssistantRecommendation"
        }
      },
      "recommendations": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/AssistantRecommendation"
        }
      },
      "groups": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/AssistantGroup"
        }
      },
      "blocked": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/AssistantRecommendation"
        }
      },
      "uncertain": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/AssistantRecommendation"
        }
      },
      "informational": {
        "type": "array",
        "items": {
          "type": "string"
        }
      },
      "activeWork": {
        "type": "object",
        "required": [
          "scanStatus",
          "acquisitionJobs"
        ],
        "properties": {
          "scanStatus": {
            "type": "string"
          },
          "acquisitionJobs": {
            "type": "number",
            "minimum": 0
          }
        }
      },
      "mediaExperience": {
        "$ref": "#/components/schemas/MediaExperience"
      },
      "discovery": {
        "$ref": "#/components/schemas/DiscoverySections"
      },
      "personalizedBriefing": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/AssistantBriefingItem"
        }
      }
    }
  },
  "AssistantOverviewSummary": {
    "type": "object",
    "required": [
      "health",
      "attentionCount",
      "counts",
      "blockedCount",
      "uncertainCount",
      "lastScan",
      "freshness"
    ],
    "properties": {
      "health": {
        "type": "string",
        "enum": [
          "healthy",
          "mostly_healthy",
          "attention_required"
        ]
      },
      "attentionCount": {
        "type": "number",
        "minimum": 0
      },
      "counts": {
        "type": "object",
        "required": [
          "critical",
          "high",
          "medium",
          "low",
          "info"
        ],
        "properties": {
          "critical": {
            "type": "number",
            "minimum": 0
          },
          "high": {
            "type": "number",
            "minimum": 0
          },
          "medium": {
            "type": "number",
            "minimum": 0
          },
          "low": {
            "type": "number",
            "minimum": 0
          },
          "info": {
            "type": "number",
            "minimum": 0
          }
        }
      },
      "blockedCount": {
        "type": "number",
        "minimum": 0
      },
      "uncertainCount": {
        "type": "number",
        "minimum": 0
      },
      "lastScan": {
        "type": [
          "string",
          "null"
        ]
      },
      "freshness": {
        "type": "string"
      }
    }
  },
  "AssistantRecommendation": {
    "type": "object",
    "required": [
      "id",
      "type",
      "priority",
      "confidence",
      "title",
      "explanation",
      "evidence",
      "recommendedAction",
      "state",
      "reviewItemId"
    ],
    "properties": {
      "id": {
        "type": "string"
      },
      "type": {
        "type": "string",
        "enum": [
          "download",
          "integrity",
          "rename",
          "duplicate",
          "identity",
          "quality"
        ]
      },
      "priority": {
        "type": "string",
        "enum": [
          "critical",
          "high",
          "medium",
          "low",
          "info"
        ]
      },
      "confidence": {
        "type": "string"
      },
      "title": {
        "type": "string"
      },
      "explanation": {
        "type": "string"
      },
      "evidence": {
        "type": "array",
        "items": {
          "type": "string"
        }
      },
      "recommendedAction": {
        "type": "string"
      },
      "state": {
        "type": "string"
      },
      "reviewItemId": {
        "type": [
          "number",
          "null"
        ]
      },
      "personalContext": {
        "type": [
          "object",
          "null"
        ],
        "required": [
          "watchState",
          "lastWatchedAt",
          "playCount",
          "watchedMinutes",
          "seriesProgress",
          "isNextEpisode"
        ],
        "properties": {
          "watchState": {
            "type": "string"
          },
          "lastWatchedAt": {
            "type": [
              "string",
              "null"
            ],
            "format": "date-time"
          },
          "playCount": {
            "type": "number",
            "minimum": 0
          },
          "watchedMinutes": {
            "type": "number",
            "minimum": 0
          },
          "seriesProgress": {
            "type": [
              "number",
              "null"
            ],
            "minimum": 0,
            "maximum": 100
          },
          "isNextEpisode": {
            "type": "boolean"
          }
        }
      },
      "personalAffinity": {
        "type": [
          "object",
          "null"
        ],
        "required": [
          "priority",
          "basedOn"
        ],
        "properties": {
          "priority": {
            "type": "string",
            "enum": [
              "high",
              "medium",
              "low",
              "unknown"
            ]
          },
          "basedOn": {
            "type": "array",
            "items": {
              "type": "string"
            }
          }
        }
      }
    }
  },
  "AssistantWorkload": {
    "type": "object",
    "required": [
      "items",
      "counts",
      "generatedAt"
    ],
    "properties": {
      "items": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/AssistantWorkloadItem"
        }
      },
      "counts": {
        "type": "object",
        "required": [
          "needs_you",
          "being_handled",
          "waiting",
          "interesting",
          "completed",
          "dismissed",
          "superseded",
          "blocked",
          "uncertain"
        ],
        "additionalProperties": false,
        "properties": {
          "needs_you": {
            "type": "number",
            "minimum": 0
          },
          "being_handled": {
            "type": "number",
            "minimum": 0
          },
          "waiting": {
            "type": "number",
            "minimum": 0
          },
          "interesting": {
            "type": "number",
            "minimum": 0
          },
          "completed": {
            "type": "number",
            "minimum": 0
          },
          "dismissed": {
            "type": "number",
            "minimum": 0
          },
          "superseded": {
            "type": "number",
            "minimum": 0
          },
          "blocked": {
            "type": "number",
            "minimum": 0
          },
          "uncertain": {
            "type": "number",
            "minimum": 0
          }
        }
      },
      "generatedAt": {
        "type": "string",
        "format": "date-time"
      }
    }
  },
  "AssistantWorkloadItem": {
    "type": "object",
    "required": [
      "id",
      "title",
      "reviewItemId",
      "findingClassification",
      "currentObservationId",
      "provider",
      "refreshId",
      "evidenceKey",
      "observedAt",
      "changeContext",
      "summary",
      "state",
      "needsUserAction",
      "nextStep",
      "destination",
      "source",
      "sourceId",
      "evidence",
      "confidence",
      "lastConfirmedAt",
      "freshness"
    ],
    "properties": {
      "id": {
        "type": "string"
      },
      "title": {
        "type": "string"
      },
      "reviewItemId": {
        "type": "number",
        "nullable": true
      },
      "findingClassification": {
        "type": "string",
        "nullable": true
      },
      "currentObservationId": {
        "type": "number",
        "nullable": true
      },
      "provider": {
        "type": "string",
        "nullable": true
      },
      "refreshId": {
        "type": "string",
        "nullable": true
      },
      "evidenceKey": {
        "type": "string",
        "nullable": true
      },
      "observedAt": {
        "type": "string",
        "format": "date-time",
        "nullable": true
      },
      "changeContext": {
        "type": "object",
        "nullable": true,
        "required": [
          "previousObservationId",
          "previousEvidenceKey",
          "previousObservedAt"
        ],
        "properties": {
          "previousObservationId": {
            "type": "number"
          },
          "previousEvidenceKey": {
            "type": "string"
          },
          "previousObservedAt": {
            "type": "string",
            "format": "date-time"
          }
        }
      },
      "summary": {
        "type": "string"
      },
      "state": {
        "type": "string",
        "enum": [
          "needs_you",
          "being_handled",
          "waiting",
          "interesting",
          "completed",
          "dismissed",
          "blocked",
          "uncertain"
        ]
      },
      "needsUserAction": {
        "type": "boolean"
      },
      "nextStep": {
        "type": "string"
      },
      "destination": {
        "type": "string",
        "enum": [
          "assistant",
          "queue",
          "history"
        ]
      },
      "source": {
        "type": "string",
        "enum": [
          "assistant",
          "download",
          "review",
          "health"
        ]
      },
      "sourceId": {
        "type": "string"
      },
      "evidence": {
        "type": "array",
        "items": {
          "type": "string"
        }
      },
      "confidence": {
        "type": [
          "string",
          "null"
        ]
      },
      "lastConfirmedAt": {
        "type": [
          "string",
          "null"
        ],
        "format": "date-time"
      },
      "freshness": {
        "type": "string",
        "enum": [
          "fresh",
          "recent",
          "stale",
          "unknown"
        ]
      }
    }
  },
  "CurrentViewingMomentum": {
    "type": "object",
    "required": [
      "activeSeriesCount",
      "recentlyWatchedCount",
      "windowDays"
    ],
    "properties": {
      "activeSeriesCount": {
        "type": "number",
        "minimum": 0
      },
      "recentlyWatchedCount": {
        "type": "number",
        "minimum": 0
      },
      "windowDays": {
        "type": "number",
        "const": 30
      }
    }
  },
  "DiscoveryItem": {
    "type": "object",
    "required": [
      "id",
      "title",
      "provider",
      "itemType",
      "releaseDate",
      "personalRelevance",
      "reasons",
      "evidence"
    ],
    "properties": {
      "id": {
        "type": "string"
      },
      "title": {
        "type": "string"
      },
      "provider": {
        "type": "string",
        "enum": [
          "plex",
          "jellyfin"
        ]
      },
      "itemType": {
        "type": "string",
        "enum": [
          "movie",
          "show",
          "episode",
          "unknown"
        ]
      },
      "releaseDate": {
        "type": [
          "string",
          "null"
        ],
        "format": "date-time"
      },
      "personalRelevance": {
        "type": "string",
        "enum": [
          "high",
          "medium",
          "low",
          "unknown"
        ]
      },
      "reasons": {
        "type": "array",
        "items": {
          "type": "string"
        }
      },
      "evidence": {
        "type": "array",
        "items": {
          "type": "string"
        }
      }
    }
  },
  "DiscoverySection": {
    "type": "object",
    "required": [
      "status",
      "reason",
      "items"
    ],
    "properties": {
      "status": {
        "type": "string",
        "enum": [
          "available",
          "limited",
          "not_available"
        ]
      },
      "reason": {
        "type": [
          "string",
          "null"
        ]
      },
      "items": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/DiscoveryItem"
        }
      }
    }
  },
  "DiscoverySections": {
    "type": "object",
    "required": [
      "upcoming",
      "recentlyReleased",
      "trending",
      "suggestedForYou"
    ],
    "properties": {
      "upcoming": {
        "$ref": "#/components/schemas/DiscoverySection"
      },
      "recentlyReleased": {
        "$ref": "#/components/schemas/DiscoverySection"
      },
      "trending": {
        "$ref": "#/components/schemas/DiscoverySection"
      },
      "suggestedForYou": {
        "$ref": "#/components/schemas/DiscoverySection"
      }
    }
  },
  "MediaExperience": {
    "type": "object",
    "required": [
      "sourceStatus",
      "items",
      "completed",
      "inProgress",
      "summary",
      "currentViewingMomentum",
      "watchlist"
    ],
    "properties": {
      "sourceStatus": {
        "type": "string",
        "enum": [
          "provider_metadata",
          "no_synced_provider_data"
        ]
      },
      "items": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/MediaExperienceItem"
        }
      },
      "completed": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/MediaExperienceItem"
        }
      },
      "inProgress": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/MediaExperienceItem"
        }
      },
      "summary": {
        "$ref": "#/components/schemas/MediaExperienceSummary"
      },
      "currentViewingMomentum": {
        "$ref": "#/components/schemas/CurrentViewingMomentum"
      },
      "watchlist": {
        "type": "object",
        "required": [
          "status",
          "items"
        ],
        "properties": {
          "status": {
            "type": "string",
            "enum": [
              "not_available"
            ]
          },
          "items": {
            "type": "array",
            "items": {
              "$ref": "#/components/schemas/MediaExperienceItem"
            }
          }
        }
      }
    }
  },
  "MediaExperienceItem": {
    "type": "object",
    "required": [
      "key",
      "provider",
      "title",
      "itemType",
      "year",
      "releaseDate",
      "durationMinutes",
      "status",
      "progressPercent",
      "playCount",
      "lastWatchedAt",
      "watchedMinutes",
      "seriesTitle",
      "seasonNumber",
      "episodeNumber",
      "seriesProgress",
      "isNextEpisode",
      "evidence"
    ],
    "properties": {
      "key": {
        "type": "string"
      },
      "provider": {
        "type": "string",
        "enum": [
          "plex",
          "jellyfin"
        ]
      },
      "title": {
        "type": "string"
      },
      "itemType": {
        "type": "string",
        "enum": [
          "movie",
          "show",
          "episode",
          "unknown"
        ]
      },
      "year": {
        "type": [
          "number",
          "null"
        ]
      },
      "releaseDate": {
        "type": [
          "string",
          "null"
        ],
        "format": "date-time"
      },
      "durationMinutes": {
        "type": [
          "number",
          "null"
        ]
      },
      "status": {
        "type": "string",
        "enum": [
          "completed",
          "in_progress",
          "unwatched",
          "unknown"
        ]
      },
      "progressPercent": {
        "type": [
          "number",
          "null"
        ]
      },
      "playCount": {
        "type": "number",
        "minimum": 0
      },
      "lastWatchedAt": {
        "type": [
          "string",
          "null"
        ],
        "format": "date-time"
      },
      "watchedMinutes": {
        "type": "number",
        "minimum": 0
      },
      "seriesTitle": {
        "type": [
          "string",
          "null"
        ]
      },
      "seasonNumber": {
        "type": [
          "number",
          "null"
        ]
      },
      "episodeNumber": {
        "type": [
          "number",
          "null"
        ]
      },
      "seriesProgress": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0,
        "maximum": 100
      },
      "isNextEpisode": {
        "type": "boolean"
      },
      "evidence": {
        "type": "array",
        "items": {
          "type": "string"
        }
      }
    }
  },
  "MediaExperienceSummary": {
    "type": "object",
    "required": [
      "completedCount",
      "inProgressCount",
      "watchedMinutes",
      "watchedHours"
    ],
    "properties": {
      "completedCount": {
        "type": "number",
        "minimum": 0
      },
      "inProgressCount": {
        "type": "number",
        "minimum": 0
      },
      "watchedMinutes": {
        "type": "number",
        "minimum": 0
      },
      "watchedHours": {
        "type": "number",
        "minimum": 0
      }
    }
  },
  "ProviderRefresh": {
    "type": "object",
    "required": [
      "refreshId",
      "provider",
      "startedAt",
      "completedAt",
      "status",
      "snapshotCompleteness",
      "itemCount",
      "authoritative",
      "reason",
      "snapshotReference"
    ],
    "properties": {
      "refreshId": {
        "type": "string"
      },
      "provider": {
        "type": "string",
        "enum": [
          "plex",
          "jellyfin"
        ]
      },
      "startedAt": {
        "type": "string",
        "format": "date-time"
      },
      "completedAt": {
        "type": "string",
        "format": "date-time",
        "nullable": true
      },
      "status": {
        "type": "string",
        "enum": [
          "syncing",
          "synced",
          "sync_error"
        ]
      },
      "snapshotCompleteness": {
        "type": "string",
        "enum": [
          "complete",
          "partial",
          "unknown"
        ]
      },
      "itemCount": {
        "type": "number",
        "nullable": true
      },
      "authoritative": {
        "type": "boolean"
      },
      "reason": {
        "type": "string",
        "nullable": true
      },
      "snapshotReference": {
        "type": "string",
        "nullable": true
      }
    }
  },
  "ProviderRefreshHistory": {
    "type": "object",
    "required": [
      "results",
      "pagination"
    ],
    "properties": {
      "results": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/ProviderRefresh"
        }
      },
      "pagination": {
        "type": "object",
        "required": [
          "page",
          "pageSize",
          "total",
          "totalPages"
        ],
        "properties": {
          "page": {
            "type": "number"
          },
          "pageSize": {
            "type": "number"
          },
          "total": {
            "type": "number"
          },
          "totalPages": {
            "type": "number"
          }
        }
      }
    }
  },
  "ProviderRefreshState": {
    "type": "object",
    "required": [
      "provider",
      "lastAttemptedRefresh",
      "lastSuccessfulRefresh",
      "currentAuthoritativeRefresh"
    ],
    "properties": {
      "provider": {
        "type": "string",
        "enum": [
          "plex",
          "jellyfin"
        ]
      },
      "lastAttemptedRefresh": {
        "allOf": [
          {
            "$ref": "#/components/schemas/ProviderRefresh"
          }
        ],
        "nullable": true
      },
      "lastSuccessfulRefresh": {
        "allOf": [
          {
            "$ref": "#/components/schemas/ProviderRefresh"
          }
        ],
        "nullable": true
      },
      "currentAuthoritativeRefresh": {
        "allOf": [
          {
            "$ref": "#/components/schemas/ProviderRefresh"
          }
        ],
        "nullable": true
      }
    }
  },
  "ReconciliationFindingLineage": {
    "type": "object",
    "required": [
      "finding",
      "currentObservation",
      "provider",
      "previousObservation"
    ],
    "properties": {
      "finding": {
        "type": "object",
        "required": [
          "reviewItemId",
          "subjectKey",
          "state",
          "classification",
          "title",
          "evidenceKey"
        ],
        "properties": {
          "reviewItemId": {
            "type": "number"
          },
          "subjectKey": {
            "type": "string"
          },
          "state": {
            "type": "string"
          },
          "classification": {
            "type": "string",
            "nullable": true
          },
          "title": {
            "type": "string"
          },
          "evidenceKey": {
            "type": "string",
            "nullable": true
          }
        }
      },
      "currentObservation": {
        "type": "object",
        "nullable": true,
        "required": [
          "observationId",
          "evidenceKey",
          "observedAt"
        ],
        "properties": {
          "observationId": {
            "type": "number"
          },
          "evidenceKey": {
            "type": "string"
          },
          "observedAt": {
            "type": "string",
            "format": "date-time"
          }
        }
      },
      "provider": {
        "type": "object",
        "nullable": true,
        "required": [
          "provider",
          "refreshId",
          "capturedAt",
          "snapshotReference"
        ],
        "properties": {
          "provider": {
            "type": "string",
            "nullable": true
          },
          "refreshId": {
            "type": "string",
            "nullable": true
          },
          "capturedAt": {
            "type": "string",
            "format": "date-time",
            "nullable": true
          },
          "snapshotReference": {
            "type": "string",
            "nullable": true
          }
        }
      },
      "previousObservation": {
        "type": "object",
        "nullable": true,
        "required": [
          "observationId",
          "evidenceKey",
          "observedAt"
        ],
        "properties": {
          "observationId": {
            "type": "number"
          },
          "evidenceKey": {
            "type": "string"
          },
          "observedAt": {
            "type": "string",
            "format": "date-time"
          }
        }
      }
    }
  },
  "ReconciliationIdentity": {
    "oneOf": [
      {
        "$ref": "#/components/schemas/ReconciliationTvIdentity"
      },
      {
        "$ref": "#/components/schemas/ReconciliationMovieIdentity"
      }
    ]
  },
  "ReconciliationLocalItem": {
    "type": "object",
    "required": [
      "fileRecordId",
      "localMediaIdentityId",
      "path",
      "relativePath",
      "volumeId",
      "archiveRoot",
      "mediaType",
      "identity",
      "scanStatus"
    ],
    "properties": {
      "fileRecordId": {
        "type": "number"
      },
      "localMediaIdentityId": {
        "type": [
          "number",
          "null"
        ]
      },
      "path": {
        "type": "string"
      },
      "relativePath": {
        "type": "string"
      },
      "volumeId": {
        "type": [
          "string",
          "null"
        ]
      },
      "archiveRoot": {
        "type": [
          "string",
          "null"
        ]
      },
      "mediaType": {
        "type": [
          "string",
          "null"
        ]
      },
      "identity": {
        "oneOf": [
          {
            "$ref": "#/components/schemas/ReconciliationIdentity"
          },
          {
            "type": "null"
          }
        ]
      },
      "scanStatus": {
        "type": "string"
      }
    }
  },
  "ReconciliationMovieIdentity": {
    "type": "object",
    "required": [
      "strategy",
      "title",
      "year"
    ],
    "properties": {
      "strategy": {
        "type": "string",
        "enum": [
          "movie_title_year",
          "fallback_title_year"
        ]
      },
      "title": {
        "type": "string"
      },
      "year": {
        "type": [
          "number",
          "null"
        ]
      }
    }
  },
  "ReconciliationPlexItem": {
    "type": "object",
    "required": [
      "id",
      "ratingKey",
      "libraryId",
      "libraryName",
      "title",
      "year",
      "itemType",
      "identity"
    ],
    "properties": {
      "id": {
        "type": "number"
      },
      "ratingKey": {
        "type": "string"
      },
      "libraryId": {
        "type": "number"
      },
      "libraryName": {
        "type": "string"
      },
      "title": {
        "type": "string"
      },
      "year": {
        "type": [
          "number",
          "null"
        ]
      },
      "itemType": {
        "type": "string"
      },
      "identity": {
        "oneOf": [
          {
            "$ref": "#/components/schemas/ReconciliationIdentity"
          },
          {
            "type": "null"
          }
        ]
      }
    }
  },
  "ReconciliationQuality": {
    "type": "object",
    "required": [
      "status",
      "differences"
    ],
    "properties": {
      "status": {
        "type": "string",
        "enum": [
          "not_compared",
          "conflict",
          "equivalent_available_metadata"
        ]
      },
      "differences": {
        "type": "array",
        "items": {
          "type": "string",
          "enum": [
            "resolution",
            "dynamic_range",
            "video_codec",
            "bitrate",
            "audio_codec",
            "audio_channels",
            "container"
          ]
        }
      }
    }
  },
  "ReconciliationReport": {
    "type": "object",
    "required": [
      "summary",
      "pagination",
      "results"
    ],
    "properties": {
      "summary": {
        "$ref": "#/components/schemas/ReconciliationSummary"
      },
      "pagination": {
        "$ref": "#/components/schemas/ReportPagination"
      },
      "results": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/ReconciliationResult"
        }
      }
    }
  },
  "ReconciliationResult": {
    "type": "object",
    "required": [
      "classification",
      "matchingStrategy",
      "candidateCount",
      "local",
      "plex",
      "ambiguityCandidates",
      "quality"
    ],
    "properties": {
      "classification": {
        "type": "string",
        "enum": [
          "matched",
          "local_only",
          "plex_only",
          "duplicate",
          "quality_conflict",
          "uncertain"
        ]
      },
      "matchingStrategy": {
        "type": "string",
        "enum": [
          "tv_show_season_episode",
          "movie_title_year",
          "fallback_title_year",
          "checksum",
          "fingerprint",
          "semantic_identity",
          "ambiguous",
          "no_match"
        ]
      },
      "candidateCount": {
        "type": "number",
        "minimum": 0
      },
      "local": {
        "oneOf": [
          {
            "$ref": "#/components/schemas/ReconciliationLocalItem"
          },
          {
            "type": "null"
          }
        ]
      },
      "plex": {
        "oneOf": [
          {
            "$ref": "#/components/schemas/ReconciliationPlexItem"
          },
          {
            "type": "null"
          }
        ]
      },
      "ambiguityCandidates": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/ReconciliationPlexItem"
        }
      },
      "quality": {
        "$ref": "#/components/schemas/ReconciliationQuality"
      }
    }
  },
  "ReconciliationSummary": {
    "type": "object",
    "required": [
      "localCount",
      "plexCount",
      "matchedCount",
      "localOnlyCount",
      "plexOnlyCount",
      "uncertainCount",
      "duplicateCount",
      "qualityConflictCount"
    ],
    "properties": {
      "localCount": {
        "type": "number",
        "minimum": 0
      },
      "plexCount": {
        "type": "number",
        "minimum": 0
      },
      "matchedCount": {
        "type": "number",
        "minimum": 0
      },
      "localOnlyCount": {
        "type": "number",
        "minimum": 0
      },
      "plexOnlyCount": {
        "type": "number",
        "minimum": 0
      },
      "uncertainCount": {
        "type": "number",
        "minimum": 0
      },
      "duplicateCount": {
        "type": "number",
        "minimum": 0
      },
      "qualityConflictCount": {
        "type": "number",
        "minimum": 0
      }
    }
  },
  "ReconciliationTvIdentity": {
    "type": "object",
    "required": [
      "strategy",
      "show",
      "season",
      "episode"
    ],
    "properties": {
      "strategy": {
        "type": "string",
        "const": "tv_show_season_episode"
      },
      "show": {
        "type": "string"
      },
      "season": {
        "type": "number"
      },
      "episode": {
        "type": "number"
      },
      "grandparentRatingKey": {
        "type": [
          "string",
          "null"
        ]
      },
      "parentRatingKey": {
        "type": [
          "string",
          "null"
        ]
      },
      "title": {
        "type": "string"
      },
      "ratingKey": {
        "type": "string"
      }
    }
  },
  "ReportPagination": {
    "type": "object",
    "required": [
      "page",
      "pageSize",
      "total",
      "totalPages"
    ],
    "properties": {
      "page": {
        "type": "number",
        "minimum": 1
      },
      "pageSize": {
        "type": "number",
        "minimum": 1
      },
      "total": {
        "type": "number",
        "minimum": 0
      },
      "totalPages": {
        "type": "number",
        "minimum": 0
      }
    }
  }
};
