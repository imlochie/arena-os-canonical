/**
 * AI provider adapters — the only place Waveyard talks to model APIs.
 *
 * Honesty rules enforced here:
 *  - audio-derived mode sends the analysis packet (measurements), and the
 *    prompt says so explicitly: the model is told it did NOT receive audio.
 *  - A provider without credentials or network is UNAVAILABLE: the adapter
 *    returns the exact reason. There is no silent fallback to canned
 *    content, ever. Non-AI functionality is untouched by this module.
 *  - Whatever comes back is raw model output until validateProposal()
 *    (the authority) has checked it. Adapters never apply anything.
 */

import type { AnalysisPacket } from "./packet";
import { capabilityLabel, type AudioAiCapability } from "./capability";
import type { AiWorkflow } from "./workflows";

export type ProviderId = "openai" | "anthropic";

export type ProviderStatus =
  | { state: "available"; providerId: ProviderId; model: string; baseUrl: string }
  | { state: "unavailable"; providerId: ProviderId; reason: string };

export type ProviderResult =
  | {
      ok: true;
      capability: AudioAiCapability;
      model: string;
      /** Raw model output (JSON text or plain analysis text). */
      raw: string;
    }
  | {
      ok: false;
      /** Honest failure — surfaced verbatim to the UI. */
      reason: string;
      httpStatus?: number;
    };

type ProviderConfig = {
  id: ProviderId;
  label: string;
  envKey: string;
  /** Env is read at call time so runtime configuration changes apply. */
  model: () => string;
  baseUrl: () => string;
};

const PROVIDERS: Record<ProviderId, ProviderConfig> = {
  openai: {
    id: "openai",
    label: "OpenAI",
    envKey: "OPENAI_API_KEY",
    model: () => process.env.OPENAI_MODEL ?? "gpt-4o-mini",
    baseUrl: () => process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
  },
  anthropic: {
    id: "anthropic",
    label: "Anthropic",
    envKey: "ANTHROPIC_API_KEY",
    model: () => process.env.ANTHROPIC_MODEL ?? "claude-3-5-sonnet-latest",
    baseUrl: () => process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com/v1",
  },
};

export function listProviders(): ProviderStatus[] {
  return (Object.keys(PROVIDERS) as ProviderId[]).map((id) => providerStatus(id));
}

export function providerStatus(id: ProviderId): ProviderStatus {
  const config = PROVIDERS[id];
  const key = process.env[config.envKey];
  if (key === undefined || key === "") {
    return {
      state: "unavailable",
      providerId: id,
      reason: `${config.label} is not configured: ${config.envKey} is not set on this machine. Set it to enable this provider.`,
    };
  }
  return {
    state: "available",
    providerId: id,
    model: config.model(),
    baseUrl: config.baseUrl(),
  };
}

export function defaultProviderId(): ProviderId {
  if (providerStatus("openai").state === "available") return "openai";
  if (providerStatus("anthropic").state === "available") return "anthropic";
  return "openai";
}

export function buildPrompt(input: {
  workflow: AiWorkflow;
  packet: AnalysisPacket;
  channelMenu: Array<{ id: string; name: string }>;
}): string {
  const { workflow, packet, channelMenu } = input;
  const processorMenu = "gain, highpass, lowpass, eq-band, notch, compressor, saturator, softclip, width, delay, channel-strip (trimDb/faderDb/pan only)";
  return [
    `You are assisting with an audio mix in Waveyard. ${capabilityLabel("audio-derived")}.`,
    "You did NOT receive audio. You received a JSON analysis packet derived from real measurements of the audio. Treat every number as ground truth and label any inference as inference.",
    "",
    `Task: ${workflow.label} — ${workflow.promptFocus}`,
    "",
    "Channels you may target (targetChannelId must be one of these exact ids):",
    ...channelMenu.map((channel) => `  - ${channel.id} (${channel.name})`),
    "",
    "Processors you may propose (the 'processor' field; parameters must be within the documented ranges):",
    `  ${processorMenu}`,
    "",
    workflow.expectation === "proposal"
      ? [
          "Respond with ONLY a JSON object of shape:",
          `{"rationale": string, "changes": [{"targetChannelId": string, "processor": string, "parameters": {name: number}, "reason": string}]}`,
          "Every change must cite the measurement that justifies it in its reason.",
        ].join("\n")
      : "Respond with a concise analysis in plain text. State evidence (numbers) for every claim and mark inferences.",
    "",
    "Analysis packet (measured, authoritative):",
    JSON.stringify(packet, null, 2),
  ].join("\n");
}

/** Extract the first JSON object from model text (models add prose). */
export function extractJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

async function callOpenAiCompatible(
  config: ProviderConfig,
  prompt: string,
  signal?: AbortSignal,
): Promise<ProviderResult> {
  const response = await fetch(`${config.baseUrl()}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env[config.envKey]}`,
    },
    body: JSON.stringify({
      model: config.model(),
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
    }),
    signal,
  }).catch((error: unknown) => ({
    ok: false as const,
    status: 0,
    text: async () => (error instanceof Error ? error.message : "network failure"),
  }));
  const body = await response.text().catch(() => "");
  if (!response.ok) {
    return {
      ok: false,
      reason: `${config.label} request failed (HTTP ${response.status}): ${body.slice(0, 300) || "no response body"}`,
      httpStatus: response.status,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, reason: `${config.label} returned a non-JSON response.` };
  }
  const content = (parsed as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0]?.message?.content;
  if (typeof content !== "string" || content === "") {
    return { ok: false, reason: `${config.label} returned no message content.` };
  }
  return { ok: true, capability: "audio-derived", model: config.model(), raw: content };
}

async function callAnthropic(
  config: ProviderConfig,
  prompt: string,
  signal?: AbortSignal,
): Promise<ProviderResult> {
  const response = await fetch(`${config.baseUrl()}/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": String(process.env[config.envKey]),
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: config.model(),
      max_tokens: 2048,
      messages: [{ role: "user", content: prompt }],
    }),
    signal,
  }).catch((error: unknown) => ({
    ok: false as const,
    status: 0,
    text: async () => (error instanceof Error ? error.message : "network failure"),
  }));
  const body = await response.text().catch(() => "");
  if (!response.ok) {
    return {
      ok: false,
      reason: `Anthropic request failed (HTTP ${response.status}): ${body.slice(0, 300) || "no response body"}`,
      httpStatus: response.status,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, reason: "Anthropic returned a non-JSON response." };
  }
  const content = (parsed as { content?: Array<{ type?: string; text?: unknown }> }).content?.[0]?.text;
  if (typeof content !== "string" || content === "") {
    return { ok: false, reason: "Anthropic returned no message content." };
  }
  return { ok: true, capability: "audio-derived", model: config.model(), raw: content };
}

export async function requestFromProvider(input: {
  providerId: ProviderId;
  workflow: AiWorkflow;
  packet: AnalysisPacket;
  channelMenu: Array<{ id: string; name: string }>;
  signal?: AbortSignal;
}): Promise<ProviderResult> {
  const status = providerStatus(input.providerId);
  if (status.state === "unavailable") return { ok: false, reason: status.reason };
  const config = PROVIDERS[input.providerId];
  const prompt = buildPrompt({ workflow: input.workflow, packet: input.packet, channelMenu: input.channelMenu });
  if (input.providerId === "anthropic") return callAnthropic(config, prompt, input.signal);
  return callOpenAiCompatible(config, prompt, input.signal);
}
