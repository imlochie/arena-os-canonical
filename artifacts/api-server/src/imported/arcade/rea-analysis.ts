import { execFile as execFileCallback } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { importedHtmlSafetyIssue } from "@workspace/arena/lib/games";

const execFile = promisify(execFileCallback);
const require = createRequire(import.meta.url);
const reaCliPath = require.resolve("rea-agents/scripts/rea.mjs");
const MAX_SOURCE_BYTES = 50_000;
const MAX_SCRIPT_COUNT = 24;
const ANALYSIS_TIMEOUT_MS = 20_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export type ReaGameAnalysis = {
  sourceBytes: number;
  scriptsFound: number;
  scriptsParsed: number;
  parseFailures: number;
  functionNames: string[];
  stateNames: string[];
  inputEvents: string[];
  gameLoopApis: string[];
  progressStores: string[];
  semanticNodeCount: number;
  relationCount: number;
  limitations: string[];
};

export class ReaAnalysisError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
    this.name = "ReaAnalysisError";
  }
}

function extractInlineScripts(html: string): string[] {
  const scripts: string[] = [];
  const scriptPattern = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  for (const match of html.matchAll(scriptPattern)) {
    const attributes = match[1] ?? "";
    if (/\bsrc\s*=/i.test(attributes)) continue;
    const typeMatch = attributes.match(/\btype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    const type = (typeMatch?.[1] ?? typeMatch?.[2] ?? typeMatch?.[3] ?? "").trim().toLowerCase();
    if (type && type !== "module" && !/^(?:text|application)\/(?:x-)?(?:java|ecma)script$/.test(type)) continue;
    const source = match[2]?.trim();
    if (source) scripts.push(source);
  }
  return scripts;
}

function uniqueStrings(values: unknown[], limit: number): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim().slice(0, 80)))].slice(0, limit);
}

function collectMatches(sources: string[], pattern: RegExp, limit: number): string[] {
  const matches: string[] = [];
  for (const source of sources) {
    for (const match of source.matchAll(pattern)) {
      if (match[1]) matches.push(match[1]);
    }
  }
  return uniqueStrings(matches, limit);
}

function analysisFromEvidence(evidence: any, sources: string[], sourceBytes: number): ReaGameAnalysis {
  const normalized = evidence?.normalized_result;
  const semantic = normalized?.semantic_graph;
  const nodes: any[] = Array.isArray(semantic?.nodes) ? semantic.nodes : [];
  const relations: any[] = Array.isArray(semantic?.relations) ? semantic.relations : [];
  if (!semantic || !Array.isArray(semantic.nodes)) {
    throw new ReaAnalysisError("REA did not return a usable static-analysis graph for this game.", 422);
  }

  const statistics = normalized?.statistics ?? {};
  const limits = [
    ...(Array.isArray(normalized?.limitations) ? normalized.limitations : []),
    ...(Array.isArray(semantic?.limitations) ? semantic.limitations : []),
  ];
  return {
    sourceBytes,
    scriptsFound: sources.length,
    scriptsParsed: Number(statistics.parsed_javascript_files ?? 0),
    parseFailures: Number(statistics.parse_failures ?? 0),
    functionNames: uniqueStrings(nodes.filter((node) => node.kind === "function").map((node) => node.label), 16),
    stateNames: uniqueStrings(nodes.filter((node) => node.kind === "binding").map((node) => node.label), 24),
    inputEvents: collectMatches(
      sources,
      /\baddEventListener\s*\(\s*['"](keydown|keyup|keypress|pointerdown|pointerup|pointermove|mousedown|mouseup|touchstart|touchend|gamepadconnected)['"]/gi,
      12,
    ),
    gameLoopApis: collectMatches(sources, /\b(requestAnimationFrame|setInterval|setTimeout)\s*\(/gi, 8),
    progressStores: collectMatches(sources, /\b(localStorage|sessionStorage|indexedDB)\b/gi, 8),
    semanticNodeCount: nodes.length,
    relationCount: relations.length,
    limitations: uniqueStrings(limits, 4),
  };
}

/** Runs REA's static JavaScript analysis only; the imported game is never executed. */
export async function analyzeImportedHtmlGame(html: string): Promise<ReaGameAnalysis> {
  const sourceBytes = Buffer.byteLength(html, "utf8");
  if (sourceBytes > MAX_SOURCE_BYTES) {
    throw new ReaAnalysisError("REA analysis is limited to 50 KB of HTML source after bundled media is removed.", 413);
  }
  const issue = importedHtmlSafetyIssue(html);
  if (issue) throw new ReaAnalysisError(issue, 422);

  const sources = extractInlineScripts(html);
  if (!sources.length) {
    throw new ReaAnalysisError("REA needs at least one bundled inline JavaScript script to analyze this game.", 422);
  }
  if (sources.length > MAX_SCRIPT_COUNT) {
    throw new ReaAnalysisError(`REA analysis is limited to ${MAX_SCRIPT_COUNT} inline scripts per game.`, 413);
  }

  let workspace = "";
  try {
    workspace = await mkdtemp(join(tmpdir(), "arenaforge-rea-"));
    for (let index = 0; index < sources.length; index += 1) {
      const filename = `game-script-${String(index + 1).padStart(2, "0")}.js`;
      await writeFile(join(workspace, filename), sources[index], { encoding: "utf8", mode: 0o600 });
    }

    const { stdout } = await execFile(
      process.execPath,
      [reaCliPath, "analyze-javascript-application", workspace, "--json"],
      {
        cwd: workspace,
        timeout: ANALYSIS_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        windowsHide: true,
      },
    );
    let evidence: unknown;
    try {
      evidence = JSON.parse(stdout);
    } catch {
      throw new ReaAnalysisError("REA returned an unreadable analysis report.", 422);
    }
    return analysisFromEvidence(evidence, sources, sourceBytes);
  } catch (error) {
    if (error instanceof ReaAnalysisError) throw error;
    const cause = error as NodeJS.ErrnoException & { killed?: boolean; code?: string | number };
    if (cause.killed || cause.code === "ETIMEDOUT") {
      throw new ReaAnalysisError("REA analysis exceeded its 20-second limit. Try a smaller game file.", 422);
    }
    if (cause.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      throw new ReaAnalysisError("REA produced a report that exceeded the safe size limit.", 422);
    }
    throw new ReaAnalysisError("REA could not analyze this game's JavaScript source.", 422);
  } finally {
    if (workspace) await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
  }
}
