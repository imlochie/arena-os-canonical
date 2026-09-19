/**
 * -----------------------------------------------------------------------------
 * AUTO-GENERATED FILE — DO NOT EDIT BY HAND.
 *
 * Source of truth : https://github.com/imlochie/SomeSafePortablesoftware/blob/arena/01a0b5e9-somesafeportablesoftware/lib/api-spec/openapi.yaml
 * Upstream ref    : imlochie/SomeSafePortablesoftware@8e54a283c392c53f64099a903b293de220e565ce
 *
 * Byte-for-byte reproducible: regenerate whenever the upstream OpenAPI
 * document changes (npm run generate:personalisation-contract), then commit both
 * generated files together. The --check mode fails if the committed output
 * is stale with respect to the given spec.
 *   npm run generate:personalisation-contract
 * -----------------------------------------------------------------------------
 */
/**
 * AUTO-GENERATED machine-readable snapshot of the Archive Assistant
 * personalisation-evidence OpenAPI subset: the single sanctioned GET
 * operation (the seventh read) plus the transitive closure of its component
 * schemas. The Gate-6 adapter's runtime validator (../validate.ts) checks
 * every upstream response against this snapshot. Regenerate; never
 * hand-edit — and never substitute remembered architecture or the retired
 * Gen-1 bridge shapes for what this snapshot says.
 */

export const personalisationContractMeta = {
  "sourceSpec": "https://github.com/imlochie/SomeSafePortablesoftware/blob/arena/01a0b5e9-somesafeportablesoftware/lib/api-spec/openapi.yaml",
  "sourceRef": "imlochie/SomeSafePortablesoftware@8e54a283c392c53f64099a903b293de220e565ce"
};

export const personalisationOperations = {
  "getArchivePersonalisationContext": {
    "method": "GET",
    "path": "/assistant/personalisation-context",
    "response": "PersonalisationContext"
  }
};

export const personalisationSchemas = {
  "BehavioralSignal": {
    "type": "object",
    "required": [
      "signalId",
      "profile",
      "signalType",
      "subjectIdentity",
      "value",
      "epistemicStatus",
      "scopeIdentity",
      "coverage",
      "provenance",
      "derivedAt"
    ],
    "properties": {
      "signalId": {
        "type": "string"
      },
      "profile": {
        "type": "string",
        "enum": [
          "long_term",
          "recent",
          "collection"
        ]
      },
      "signalType": {
        "type": "string"
      },
      "subjectIdentity": {
        "type": "string"
      },
      "value": {
        "type": "object",
        "additionalProperties": true
      },
      "epistemicStatus": {
        "type": "string",
        "enum": [
          "derived"
        ]
      },
      "scopeIdentity": {
        "type": "string"
      },
      "coverage": {
        "type": "object",
        "additionalProperties": true
      },
      "provenance": {
        "$ref": "#/components/schemas/SignalProvenance"
      },
      "derivedAt": {
        "type": "string"
      }
    },
    "additionalProperties": true
  },
  "PersonalisationCollectionFact": {
    "allOf": [
      {
        "$ref": "#/components/schemas/BehavioralSignal"
      },
      {
        "type": "object",
        "required": [
          "evidenceClass"
        ],
        "properties": {
          "evidenceClass": {
            "type": "string",
            "enum": [
              "collection_fact"
            ]
          }
        }
      }
    ]
  },
  "PersonalisationContext": {
    "type": "object",
    "required": [
      "domain",
      "facts",
      "observedSignals",
      "temporalSignals",
      "collectionFacts",
      "interpretations",
      "uncertainties",
      "explicitPreferences",
      "constraints"
    ],
    "properties": {
      "domain": {
        "type": "string"
      },
      "facts": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/PersonalisationFact"
        }
      },
      "observedSignals": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/PersonalisationObservedSignal"
        }
      },
      "temporalSignals": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/PersonalisationTemporalSignal"
        }
      },
      "collectionFacts": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/PersonalisationCollectionFact"
        }
      },
      "interpretations": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/PersonalisationInterpretation"
        }
      },
      "uncertainties": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/PersonalisationUncertainty"
        }
      },
      "explicitPreferences": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": true
        }
      },
      "constraints": {
        "type": "array",
        "items": {
          "type": "string"
        }
      }
    }
  },
  "PersonalisationFact": {
    "type": "object",
    "required": [
      "evidenceClass",
      "factType",
      "value",
      "epistemicStatus",
      "provenance"
    ],
    "properties": {
      "evidenceClass": {
        "type": "string",
        "enum": [
          "fact"
        ]
      },
      "factType": {
        "type": "string"
      },
      "value": {},
      "epistemicStatus": {
        "type": "string",
        "enum": [
          "observed",
          "derived",
          "coverage-limited",
          "unknown"
        ]
      },
      "provenance": {
        "type": "object",
        "additionalProperties": true
      }
    },
    "additionalProperties": true
  },
  "PersonalisationInterpretation": {
    "type": "object",
    "required": [
      "evidenceClass"
    ],
    "properties": {
      "evidenceClass": {
        "type": "string",
        "enum": [
          "interpretation"
        ]
      },
      "statement": {
        "type": "string"
      },
      "epistemicStatus": {
        "type": "string",
        "enum": [
          "derived",
          "unknown"
        ]
      },
      "provenance": {
        "type": "object",
        "additionalProperties": true
      }
    },
    "additionalProperties": true
  },
  "PersonalisationObservedSignal": {
    "allOf": [
      {
        "$ref": "#/components/schemas/BehavioralSignal"
      },
      {
        "type": "object",
        "required": [
          "evidenceClass"
        ],
        "properties": {
          "evidenceClass": {
            "type": "string",
            "enum": [
              "observed_signal"
            ]
          }
        }
      }
    ]
  },
  "PersonalisationTemporalSignal": {
    "allOf": [
      {
        "$ref": "#/components/schemas/BehavioralSignal"
      },
      {
        "type": "object",
        "required": [
          "evidenceClass",
          "value"
        ],
        "properties": {
          "evidenceClass": {
            "type": "string",
            "enum": [
              "temporal_signal"
            ]
          },
          "value": {
            "$ref": "#/components/schemas/TemporalSignalValue"
          }
        }
      }
    ]
  },
  "PersonalisationUncertainty": {
    "type": "object",
    "required": [
      "evidenceClass"
    ],
    "properties": {
      "evidenceClass": {
        "type": "string",
        "enum": [
          "uncertainty"
        ]
      },
      "reason": {
        "type": "string"
      },
      "epistemicStatus": {
        "type": "string",
        "enum": [
          "coverage-limited",
          "unknown"
        ]
      },
      "scopeIdentity": {
        "type": "string"
      },
      "coverage": {
        "type": "object",
        "additionalProperties": true
      },
      "provenance": {
        "type": "object",
        "additionalProperties": true
      }
    },
    "additionalProperties": true
  },
  "SignalProvenance": {
    "type": "object",
    "required": [
      "derivedFrom",
      "observationIds",
      "eventIds",
      "evidenceKeys",
      "providerEventIds",
      "ingestionBatchIds",
      "batchIds",
      "eventOccurredAt",
      "observedAt",
      "scopeIdentity"
    ],
    "properties": {
      "derivedFrom": {
        "type": "string"
      },
      "observationIds": {
        "type": "array",
        "items": {
          "type": "number",
          "multipleOf": 1
        }
      },
      "eventIds": {
        "type": "array",
        "items": {
          "type": "number",
          "multipleOf": 1
        }
      },
      "evidenceKeys": {
        "type": "array",
        "items": {
          "type": "string"
        }
      },
      "providerEventIds": {
        "type": "array",
        "items": {
          "type": "string"
        }
      },
      "ingestionBatchIds": {
        "type": "array",
        "items": {
          "type": "string"
        }
      },
      "batchIds": {
        "type": "array",
        "items": {
          "type": "string"
        }
      },
      "eventOccurredAt": {
        "type": "array",
        "items": {
          "type": "string"
        }
      },
      "observedAt": {
        "type": "array",
        "items": {
          "type": "string"
        }
      },
      "scopeIdentity": {
        "type": "string"
      }
    },
    "additionalProperties": true
  },
  "TemporalSignalValue": {
    "type": "object",
    "required": [
      "window"
    ],
    "properties": {
      "window": {
        "$ref": "#/components/schemas/TemporalWindow"
      },
      "previousWindow": {
        "description": "Legacy compatibility field; new producers emit a separate previous temporal row.",
        "$ref": "#/components/schemas/TemporalWindow"
      }
    },
    "additionalProperties": true
  },
  "TemporalWindow": {
    "type": "object",
    "required": [
      "startsAt",
      "endsAt"
    ],
    "properties": {
      "startsAt": {
        "type": "string"
      },
      "endsAt": {
        "type": "string"
      }
    },
    "additionalProperties": false
  }
};
