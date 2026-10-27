/**
 * AI proposals — the safety boundary between "AI recommends" and
 * "Waveyard does".
 *
 * The model may only emit an AIProposal: a list of changes, each targeting
 * an existing channel with a known processor (or the channel strip) and
 * numeric parameters. Waveyard validates (unknown target/processor ⇒
 * reject; out-of-range ⇒ clamp and record), then applies transactionally:
 * the result is a NEW mixer state plus the previous state as the undo
 * record. Source assets are not reachable from this module at all — AI
 * actions cannot mutate sources by construction.
 */

import { z } from "zod";

import {
  INSERT_PARAM_RANGES,
  makeInsert,
  validateInsertParams,
  type InsertProcessorId,
  type ParamValidation,
} from "../mixer/inserts";
import {
  findChannel,
  updateChannel,
  availableProcessors,
} from "../mixer/state";
import {
  clamp,
  FADER_DB_RANGE,
  PAN_RANGE,
  TRIM_DB_RANGE,
  type MixerState,
} from "../mixer/types";

export const CHANNEL_STRIP_PROCESSOR = "channel-strip" as const;

export const AIProposalSchema = z.object({
  rationale: z.string().min(1),
  changes: z
    .array(
      z.object({
        targetChannelId: z.string().min(1),
        processor: z.string().min(1),
        parameters: z.record(z.string(), z.unknown()).default({}),
        reason: z.string().min(1),
      }),
    )
    .min(1),
});

export type AIProposal = z.infer<typeof AIProposalSchema>;

export const CHANNEL_STRIP_RANGES = {
  trimDb: TRIM_DB_RANGE,
  faderDb: FADER_DB_RANGE,
  pan: PAN_RANGE,
} as const;

export type ClampRecord = {
  channelId: string;
  parameter: string;
  from: number;
  to: number;
};

export type ProposalValidation = {
  valid: boolean;
  errors: string[];
  clamped: ClampRecord[];
  /** Normalized proposal (only present when valid). */
  proposal: AIProposal | null;
};

/**
 * Validate a raw AI response against the mixer state. Structural problems
 * and unknown targets/processors are ERRORS (rejected). Out-of-range
 * numeric parameters are CLAMPED and recorded so the user can see what
 * the model actually asked for.
 */
export function validateProposal(
  state: MixerState,
  raw: unknown,
): ProposalValidation {
  const parsed = AIProposalSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      valid: false,
      errors: [`proposal does not match the contract: ${parsed.error.issues.map((issue) => issue.path.join(".")).join(", ")}`],
      clamped: [],
      proposal: null,
    };
  }

  const knownProcessors = new Set<string>(availableProcessors());
  knownProcessors.add(CHANNEL_STRIP_PROCESSOR);

  const errors: string[] = [];
  const clamped: ClampRecord[] = [];
  const changes: AIProposal["changes"] = [];

  for (const change of parsed.data.changes) {
    const channel = findChannel(state, change.targetChannelId);
    if (channel === undefined) {
      errors.push(`unknown target channel: ${change.targetChannelId}`);
      continue;
    }
    if (!knownProcessors.has(change.processor)) {
      errors.push(`unknown processor: ${change.processor}`);
      continue;
    }

    if (change.processor === CHANNEL_STRIP_PROCESSOR) {
      const params: Record<string, number> = {};
      for (const [key, value] of Object.entries(change.parameters)) {
        const range = CHANNEL_STRIP_RANGES[key as keyof typeof CHANNEL_STRIP_RANGES];
        if (range === undefined) {
          errors.push(`unknown channel-strip parameter: ${key}`);
          continue;
        }
        if (typeof value !== "number" || !Number.isFinite(value)) {
          errors.push(`non-numeric parameter: ${key}`);
          continue;
        }
        const bounded = clamp(value, range.min, range.max);
        if (bounded !== value)
          clamped.push({ channelId: channel.id, parameter: key, from: value, to: bounded });
        params[key] = bounded;
      }
      changes.push({ ...change, parameters: params });
      continue;
    }

    const validation = validateInsertParameters(change.processor, change.parameters);
    if (validation === null) {
      errors.push(`invalid parameters for ${change.processor}`);
      continue;
    }
    for (const key of validation.clamped) {
      clamped.push({
        channelId: channel.id,
        parameter: key,
        from: Number(change.parameters[key]),
        to: validation.params[key],
      });
    }
    changes.push({ ...change, parameters: validation.params });
  }

  if (errors.length > 0) return { valid: false, errors, clamped, proposal: null };
  return { valid: true, errors: [], clamped, proposal: { rationale: parsed.data.rationale, changes } };
}

function validateInsertParameters(
  processor: string,
  parameters: Record<string, unknown>,
): ParamValidation | null {
  // Reuse the insert registry's validation (clamps + rejects unknown keys).
  return validateInsertParams(processor, parameters);
}

export type AppliedChange = {
  channelId: string;
  channelName: string;
  processor: string;
  parameters: Record<string, number>;
  reason: string;
};

export type ApplyProposalResult = {
  status: "applied" | "rejected";
  next?: MixerState;
  /** The state before application — the undo record. */
  undo?: MixerState;
  applied: AppliedChange[];
  clamped: ClampRecord[];
  errors: string[];
};

/**
 * Validate + apply in one transactional step. On any validation error the
 * original state is returned untouched. Application only ever produces a
 * new MixerState — it has no capability to touch files, sources, or jobs.
 */
export function applyProposal(state: MixerState, raw: unknown): ApplyProposalResult {
  const validation = validateProposal(state, raw);
  if (!validation.valid || validation.proposal === null) {
    return { status: "rejected", applied: [], clamped: validation.clamped, errors: validation.errors };
  }

  let next: MixerState = state;
  const applied: AppliedChange[] = [];
  for (const change of validation.proposal.changes) {
    const channel = findChannel(state, change.targetChannelId);
    if (channel === undefined) continue; // already validated; defensive
    if (change.processor === CHANNEL_STRIP_PROCESSOR) {
      const params = change.parameters as Record<string, number>;
      next = updateChannel(next, channel.id, {
        ...(params.trimDb !== undefined ? { trimDb: params.trimDb } : {}),
        ...(params.faderDb !== undefined ? { faderDb: params.faderDb } : {}),
        ...(params.pan !== undefined ? { pan: params.pan } : {}),
      });
      applied.push({
        channelId: channel.id,
        channelName: channel.name,
        processor: CHANNEL_STRIP_PROCESSOR,
        parameters: params,
        reason: change.reason,
      });
      continue;
    }
    const insert = makeInsert(change.processor as InsertProcessorId, change.parameters as Record<string, number>);
    if (insert === null) {
      return {
        status: "rejected",
        applied: [],
        clamped: validation.clamped,
        errors: [`insert construction failed for ${change.processor}`],
      };
    }
    const current = findChannel(next, channel.id) ?? channel;
    next = updateChannel(next, channel.id, { inserts: [...current.inserts, insert] });
    applied.push({
      channelId: channel.id,
      channelName: channel.name,
      processor: change.processor,
      parameters: insert.params,
      reason: change.reason,
    });
  }

  return {
    status: "applied",
    next,
    undo: state,
    applied,
    clamped: validation.clamped,
    errors: [],
  };
}
