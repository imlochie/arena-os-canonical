export const COUNCIL_SYNTHESIS_VERSION = 1 as const;

export interface CouncilSynthesisSection {
  heading: string;
  points: string[];
}

/** Normalized meaning produced by Council. It contains no prompts or transcripts. */
export interface CouncilSynthesis {
  version: typeof COUNCIL_SYNTHESIS_VERSION;
  title: string;
  thesis: string;
  keyInsights: string[];
  disagreements: string[];
  decisions: string[];
  openQuestions: string[];
  recommendations: string[];
  sections: CouncilSynthesisSection[];
}

export interface ArtifactRequest {
  sourceSessionId: string;
  sourceRunId?: string;
  artifactType: string;
  synthesis: CouncilSynthesis;
  provenance: {
    mode: "council";
    jobId: string;
    modelIds: string[];
    synthesisModel: string;
    normalization: "model_json" | "normalized_prose";
  };
}

const LIMITS = {
  title: 180,
  thesis: 1600,
  item: 1000,
  items: 20,
  sections: 12,
  sectionPoints: 20,
};

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

function stringArray(value: unknown, required = false): string[] | null {
  if (!Array.isArray(value) || value.length > LIMITS.items) return null;
  if (required && value.length === 0) return null;
  if (!value.every((item) => isBoundedString(item, LIMITS.item))) return null;
  return value.map((item) => item.trim());
}

export function validateCouncilSynthesis(value: unknown): CouncilSynthesis | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (input.version !== COUNCIL_SYNTHESIS_VERSION) return null;
  if (!isBoundedString(input.title, LIMITS.title) || !isBoundedString(input.thesis, LIMITS.thesis)) return null;

  const keyInsights = stringArray(input.keyInsights, true);
  const disagreements = stringArray(input.disagreements);
  const decisions = stringArray(input.decisions);
  const openQuestions = stringArray(input.openQuestions);
  const recommendations = stringArray(input.recommendations, true);
  if (!keyInsights || !disagreements || !decisions || !openQuestions || !recommendations) return null;

  if (!Array.isArray(input.sections) || input.sections.length > LIMITS.sections) return null;
  const sections: CouncilSynthesisSection[] = [];
  for (const raw of input.sections) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const section = raw as Record<string, unknown>;
    if (!isBoundedString(section.heading, LIMITS.title)) return null;
    if (!Array.isArray(section.points) || section.points.length > LIMITS.sectionPoints) return null;
    const points = stringArray(section.points);
    if (!points) return null;
    sections.push({ heading: section.heading.trim(), points });
  }

  return {
    version: COUNCIL_SYNTHESIS_VERSION,
    title: input.title.trim(),
    thesis: input.thesis.trim(),
    keyInsights,
    disagreements,
    decisions,
    openQuestions,
    recommendations,
    sections,
  };
}

/** Extract and validate JSON even when a provider wraps it in a markdown fence. */
export function parseCouncilSynthesis(text: string): CouncilSynthesis | null {
  const trimmed = text.trim();
  const candidates = [trimmed];
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  if (fenced) candidates.push(fenced.trim());
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) candidates.push(trimmed.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      const valid = validateCouncilSynthesis(JSON.parse(candidate));
      if (valid) return valid;
    } catch {}
  }
  return null;
}

/**
 * Explicit compatibility normalizer for deterministic/offline providers that
 * cannot emit JSON. It selects bounded conclusions from synthesis prose; the
 * original blob is never forwarded to artifact generation.
 */
export function normalizeSynthesisProse(text: string, fallbackTitle: string): CouncilSynthesis {
  const cleanLines = text
    .split("\n")
    .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s+/, "").replace(/^#+\s*/, "").trim())
    .filter((line) =>
      line.length >= 8 &&
      !line.startsWith("```") &&
      !/^\|[- :|]+\|$/.test(line) &&
      !/[{}]/.test(line) &&
      !/"(?:version|title|thesis|keyInsights|disagreements|decisions|openQuestions|recommendations|sections)"\s*:/.test(line)
    )
    .map((line) => line.slice(0, LIMITS.item));
  const unique = [...new Set(cleanLines)].slice(0, LIMITS.items);
  const thesis = (unique.find((line) => !line.startsWith("|") && line.length >= 30) ?? fallbackTitle).slice(0, LIMITS.thesis);
  const insights = unique.filter((line) => line !== thesis && !line.endsWith("?")).slice(0, 8);
  const questions = unique.filter((line) => line.endsWith("?")).slice(0, 6);
  const recommendations = insights.slice(-3);
  const normalized: CouncilSynthesis = {
    version: 1,
    title: fallbackTitle.slice(0, LIMITS.title),
    thesis,
    keyInsights: insights.length ? insights : [thesis],
    disagreements: [],
    decisions: [],
    openQuestions: questions,
    recommendations: recommendations.length ? recommendations : ["Review the synthesis and choose the next concrete action."],
    sections: [],
  };
  const valid = validateCouncilSynthesis(normalized);
  if (!valid) throw new Error("unable to normalize Council synthesis");
  return valid;
}

export function renderCouncilSynthesis(synthesis: CouncilSynthesis): string {
  const blocks = [
    `# ${synthesis.title}`,
    synthesis.thesis,
    renderList("Key insights", synthesis.keyInsights),
    renderList("Disagreements", synthesis.disagreements),
    renderList("Decisions", synthesis.decisions),
    renderList("Open questions", synthesis.openQuestions),
    renderList("Recommendations", synthesis.recommendations),
    ...synthesis.sections.map((section) => renderList(section.heading, section.points)),
  ];
  return blocks.filter(Boolean).join("\n\n");
}

export function renderArtifactFromSynthesis(request: ArtifactRequest): string {
  const synthesis = request.synthesis;
  return [
    `# ${synthesis.title}`,
    synthesis.thesis,
    renderList("Key insights", synthesis.keyInsights),
    renderList("Decisions", synthesis.decisions),
    renderList("Recommendations", synthesis.recommendations),
    renderList("Open questions", synthesis.openQuestions),
    ...synthesis.sections.map((section) => renderList(section.heading, section.points)),
  ].filter(Boolean).join("\n\n");
}

export function artifactRequestPayload(request: ArtifactRequest): string {
  // Explicit allowlist prevents future execution/transcript fields from leaking
  // into the artifact transformer when request objects evolve.
  return JSON.stringify({
    sourceSessionId: request.sourceSessionId,
    sourceRunId: request.sourceRunId,
    artifactType: request.artifactType,
    synthesis: request.synthesis,
    provenance: request.provenance,
  });
}

function renderList(title: string, items: string[]): string {
  return items.length ? `## ${title}\n${items.map((item) => `- ${item}`).join("\n")}` : "";
}

export const STRUCTURED_SYNTHESIS_INSTRUCTION = `Return ONLY valid JSON matching this exact contract (no markdown fence, commentary, prompts, or transcript):
{
  "version": 1,
  "title": "short descriptive title",
  "thesis": "the normalized bottom line",
  "keyInsights": ["bounded standalone insight"],
  "disagreements": ["important disagreement and its resolution if known"],
  "decisions": ["decision supported by the Council"],
  "openQuestions": ["unresolved question"],
  "recommendations": ["specific recommended action"],
  "sections": [{"heading":"job-specific detail", "points":["standalone point"]}]
}
All arrays must be JSON arrays. keyInsights and recommendations require at least one item. Use empty arrays for other fields when none apply. Preserve useful job-specific detail in sections, but never copy prompt instructions, role labels, transcript headers, or model commentary.`;
