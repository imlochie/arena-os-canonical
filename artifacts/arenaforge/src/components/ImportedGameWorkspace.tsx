"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Copy, Download, FileCode2, Gamepad2, HardDrive, ShieldCheck, Trash2, Upload } from "lucide-react";
import { useArcadeGameSave } from "../lib/arcadeGameSave";
import { ArcadeSaveWarning } from "./ArcadeSaveWarning";
import { browserHtmlAdapter, browserNesAdapter } from "../lib/arcadeRuntimeAdapters";
import { useArcadeManagement } from "../lib/useArcadeManagement";
import ArcadeGameManagement from "./ArcadeGameManagement";
import type { ArcadeGameDescriptor } from "../lib/arcadeManifest";
import { importedGameRecordsMatch, importedGameStorageChanges, ImportedGameStorageConflictError, loadImportedGameRecords, loadImportedGames, saveImportedGameChanges, subscribeImportedGamesChanged } from "../lib/importedGameStorage";
import { deleteNesSaveState, readNesSaveState, writeNesSaveState } from "../lib/nesSaveStates";
import {
  arcadeEmulatorSystemLabel,
  ARCADE_EMULATOR_SYSTEMS,
  detectArcadeEmulatorSystem,
  isArcadeEmulatorSystemId,
  type ArcadeEmulatorSystemId,
} from "../lib/arcadeEmulatorRuntime";
import { importedHtmlSafetyIssue } from "@workspace/arena/lib/games";
import { neutralizeOfflineNavigation, prepareOfflineHtml } from "../lib/offlineGameNavigation";
import { archiveStylesheetImports } from "../lib/offlineGameStyles";
import EmulatorJsPlayer from "./EmulatorJsPlayer";
import Chip8Player from "./Chip8Player";
import ImportedGameSourceComparison from "./ImportedGameSourceComparison";
import ImportedGameProgressBackup from "./ImportedGameProgressBackup";
import ImportedGameSourceBackup from "./ImportedGameSourceBackup";
import type { SourceBackupGame } from "../lib/importedGameSourceBackup";
import { keepImportedRevision, undoImportedRevision, restoreImportedRevision, getImportedRevisionHistory, importedRevisionMetadataValid, MAX_IMPORTED_REVISION_COPIES, MAX_IMPORTED_REVISION_BYTES, type ImportedRevisionRollback } from "../lib/importedGameRevision";
import { CHIP8_MAX_ROM_BYTES, chip8DialectForFile, chip8DialectLabel, isChip8Dialect, type Chip8Dialect } from "../lib/chip8Runtime";
import type { ButtonKey, NES } from "jsnes";
import type { ArcadeRepositoryProvenance } from "@workspace/api-client-react";
import RepositoryGameImport from "./RepositoryGameImport";
import type { WorkshopPlayback } from "../lib/modWorkshopTypes";
import { getNativeBridge } from "./nativeArcadeTypes";
import { isRepositoryProvenance, resolveRepositoryAttribution, withRepositoryAttribution, withoutRepositoryAttribution } from "../lib/importedRepositoryAttribution";

type ImportedGame = {
  id: string;
  name: string;
  kind: "html" | "nes" | "emulator" | "chip8";
  source: string;
  revisionUndoSource?: string;
  revisionRollback?: ImportedRevisionRollback;
  revisionHistory?: ImportedRevisionRollback[];
  revisionLabel?: string;
  revisionUndoLabel?: string;
  addedAt: number;
  system?: ArcadeEmulatorSystemId;
  romData?: ArrayBuffer;
  chip8Dialect?: Chip8Dialect;
  provenance?: ArcadeRepositoryProvenance;
};

type ReaGameAnalysis = {
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

type ImportedGameWorkspaceProps = {
  onReviseSource(sourceHtml: string, instruction: string, signal: AbortSignal): Promise<string>;
  onUseRemakePrompt(prompt: string): void;
  /** Optional mod-profile playback. Only runtime bindings and saves change; the base shelf record is never replaced. */
  workshopLaunch?: WorkshopPlayback | null;
  onExitWorkshop?: () => void;
};

const MAX_ARCHIVE_CONTENT_BYTES = 6 * 1024 * 1024;
const MAX_HTML_BYTES = MAX_ARCHIVE_CONTENT_BYTES;
const MAX_ROM_BYTES = 1024 * 1024;
const MAX_EMULATOR_ROM_BYTES = 64 * 1024 * 1024;
const MAX_CHIP8_ROM_BYTES = CHIP8_MAX_ROM_BYTES;
const MAX_ARCHIVE_BYTES = 3 * 1024 * 1024;
const MAX_ARCHIVE_FILES = 128;
const BUTTON = {
  A: 0 as ButtonKey,
  B: 1 as ButtonKey,
  SELECT: 2 as ButtonKey,
  START: 3 as ButtonKey,
  UP: 4 as ButtonKey,
  DOWN: 5 as ButtonKey,
  LEFT: 6 as ButtonKey,
  RIGHT: 7 as ButtonKey,
};
const RIGHTS_COPY = "I own this game or have permission to use and play it. ROM files stay in this browser; HTML runs locally in a restricted iframe.";
function htmlSafetyIssue(html: string): string | null {
  return importedHtmlSafetyIssue(html);
}

function maskEmbeddedAssets(html: string) {
  const assets = new Map<string, string>();
  let index = 0;
  const source = html.replace(/data:[^,'"\s<>]+;base64,[A-Za-z0-9+/=]+/gi, (dataUrl) => {
    const token = `data:ARENA_ASSET_TOKEN_${String(++index).padStart(4, "0")}`;
    assets.set(token, dataUrl);
    return token;
  });
  return { source, assets };
}

function restoreEmbeddedAssets(source: string, assets: Map<string, string>) {
  let restored = source;
  for (const [token, dataUrl] of assets) {
    const occurrences = restored.split(token).length - 1;
    if (occurrences !== 1) {
      throw new Error("The model changed or removed a bundled media marker, so the original game was left unchanged.");
    }
    restored = restored.replace(token, dataUrl);
  }
  if (/ARENA_ASSET_TOKEN_/i.test(restored)) {
    throw new Error("The model returned an unknown media marker, so the original game was left unchanged.");
  }
  return restored;
}

function archivePath(basePath: string, reference: string): string | null {
  const value = reference.trim();
  if (!value || /^(?:data:|blob:|#|javascript:)/i.test(value)) return null;
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(value)) {
    throw new Error("This project uses an external resource. Only offline game archives are supported.");
  }
  let decoded = value.split(/[?#]/, 1)[0];
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    throw new Error("The game archive contains an invalid resource path.");
  }
  const parts = decoded.startsWith("/") ? [] : basePath.split("/").slice(0, -1);
  for (const part of decoded.replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) throw new Error("The game archive contains a path outside its folder.");
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join("/");
}

function mimeType(path: string) {
  const extension = path.split(".").pop()?.toLowerCase();
  const types: Record<string, string> = {
    avif: "image/avif", css: "text/css", gif: "image/gif", ico: "image/x-icon",
    jpeg: "image/jpeg", jpg: "image/jpeg", js: "text/javascript", json: "application/json",
    m4a: "audio/mp4", mp3: "audio/mpeg", mp4: "video/mp4", ogg: "audio/ogg",
    otf: "font/otf", png: "image/png", svg: "image/svg+xml", ttf: "font/ttf",
    wav: "audio/wav", webm: "video/webm", webp: "image/webp", woff: "font/woff", woff2: "font/woff2",
    xml: "application/xml",
  };
  return types[extension ?? ""] ?? "application/octet-stream";
}

type ArchiveByteBudget = { remaining: number };
function reserveArchiveBytes(budget: ArchiveByteBudget, bytes: number) {
  budget.remaining -= bytes;
  if (budget.remaining < 0) throw new Error("Inlined game assets exceed 6 MB. Repeated asset references also count toward this limit.");
}

async function inlineArchiveCss(
  css: string,
  cssPath: string,
  files: Record<string, any>,
  seen = new Set<string>(),
  budget: ArchiveByteBudget = { remaining: MAX_ARCHIVE_CONTENT_BYTES },
): Promise<string> {
  if (seen.has(cssPath)) throw new Error("The project contains a circular stylesheet import.");
  const nextSeen = new Set(seen);
  nextSeen.add(cssPath);
  const imports = archiveStylesheetImports(css);
  for (const match of imports) {
    const targetPath = archivePath(cssPath, match.reference);
    if (!targetPath) continue;
    const target = files[targetPath];
    if (!target) throw new Error(`The archive is missing stylesheet ${match.reference}.`);
    if (/\b(?:layer|supports)\b/i.test(match.media)) throw new Error("Bundle CSS layer/supports imports before importing this game.");
    const nested = await target.async("string");
    reserveArchiveBytes(budget, new TextEncoder().encode(nested).byteLength);
    const rewritten = await inlineArchiveCss(nested, targetPath, files, nextSeen, budget);
    css = css.replace(match.statement, () => match.media ? `@media ${match.media} {\n${rewritten}\n}` : rewritten);
  }
  const urls = [...css.matchAll(/url\(\s*(?:(['"])(.*?)\1|([^)'"\s][^)]*))\s*\)/gi)];
  for (const match of urls) {
    const reference = (match[2] ?? match[3] ?? "").trim();
    const targetPath = archivePath(cssPath, reference);
    if (!targetPath) continue;
    const target = files[targetPath];
    if (!target) throw new Error(`The archive is missing style asset ${reference}.`);
    const bytes = await target.async("uint8array");
    reserveArchiveBytes(budget, Math.ceil(bytes.byteLength * 4 / 3) + 64);
    const dataUrl = `data:${mimeType(targetPath)};base64,${toBase64(bytes)}`;
    css = css.replace(match[0], `url("${dataUrl}")`);
  }
  return css;
}

async function inlineArchiveScriptMediaSources(
  source: string,
  htmlPath: string,
  files: Record<string, any>,
  budget: ArchiveByteBudget = { remaining: MAX_ARCHIVE_CONTENT_BYTES },
): Promise<string> {
  const audioCalls = [...source.matchAll(/\bnew\s+Audio\s*\(\s*(["'])([^"'\\\r\n]+)\1\s*\)/gi)]
    .map((match) => ({ match, audio: true }));
  const mediaAssignments = [...source.matchAll(/\.src\s*=\s*(["'])([^"'\\\r\n]+\.(?:avif|gif|ico|jpe?g|png|svg|webp|m4a|mp3|mp4|ogg|wav|webm)(?:[?#][^"'\\\r\n]*)?)\1/gi)]
    .map((match) => ({ match, audio: false }));
  const matches = [...audioCalls, ...mediaAssignments]
    .sort((left, right) => (right.match.index ?? 0) - (left.match.index ?? 0));
  let rewritten = source;
  for (const { match, audio } of matches) {
    const reference = match[2].trim();
    if (/^(?:data:|blob:)/i.test(reference)) continue;
    const path = archivePath(htmlPath, reference);
    if (!path) continue;
    const target = files[path];
    if (!target) throw new Error(`The archive is missing game media ${reference}.`);
    if (audio && !/\.(?:m4a|mp3|ogg|wav)$/i.test(path.split(/[?#]/, 1)[0])) {
      throw new Error(`The game audio source ${reference} must use an audio file.`);
    }
    const bytes = await target.async("uint8array");
    reserveArchiveBytes(budget, Math.ceil(bytes.byteLength * 4 / 3) + 64);
    const dataUrl = `data:${mimeType(path)};base64,${toBase64(bytes)}`;
    const quote = match[1];
    const oldLiteral = `${quote}${match[2]}${quote}`;
    const newLiteral = `${quote}${dataUrl}${quote}`;
    const replacement = match[0].replace(oldLiteral, newLiteral);
    const start = match.index ?? 0;
    rewritten = `${rewritten.slice(0, start)}${replacement}${rewritten.slice(start + match[0].length)}`;
  }
  return rewritten;
}

async function bundleOfflineBrowserGame(file: File): Promise<string> {
  if (file.size > MAX_ARCHIVE_BYTES) throw new Error("Game archives are limited to 3 MB compressed.");
  const JSZip = (await import("jszip")).default;
  const archive = await JSZip.loadAsync(file);
  const entries = Object.values(archive.files).filter((entry: any) => !entry.dir && !entry.name.startsWith("__MACOSX/"));
  if (!entries.length || entries.length > MAX_ARCHIVE_FILES) {
    throw new Error(`A game archive must contain between 1 and ${MAX_ARCHIVE_FILES} files.`);
  }
  const files: Record<string, any> = Object.create(null);
  let estimatedBytes = 0;
  for (const entry of entries as any[]) {
    const path = archivePath("", entry.name);
    if (!path) continue;
    if ((typeof entry.unixPermissions === "number" && (entry.unixPermissions & 0xf000) === 0xa000) ||
        (entry._data?.uncompressedSize ?? 0) > MAX_ARCHIVE_CONTENT_BYTES) {
      throw new Error("The game archive contains a symbolic link or an oversized file.");
    }
    estimatedBytes += entry._data?.uncompressedSize ?? 0;
    if (estimatedBytes > MAX_ARCHIVE_CONTENT_BYTES) {
      throw new Error("Unpacked game projects are limited to 6 MB.");
    }
    files[path] = entry;
  }

  const htmlPaths = Object.keys(files).filter((path) => /\.html?$/i.test(path));
  const entryPath = htmlPaths.sort((a, b) => {
    const aIndex = /(?:^|\/)index\.html?$/i.test(a) ? 0 : 1;
    const bIndex = /(?:^|\/)index\.html?$/i.test(b) ? 0 : 1;
    return aIndex - bIndex || a.length - b.length;
  })[0];
  if (!entryPath) throw new Error("The archive needs an index.html file or one HTML game page.");

  const entryFile = files[entryPath];
  let source = await entryFile.async("string");
  const budget = { remaining: MAX_ARCHIVE_CONTENT_BYTES };
  reserveArchiveBytes(budget, new TextEncoder().encode(source).byteLength);
  const document = new DOMParser().parseFromString(source, "text/html");
  for (const script of Array.from(document.querySelectorAll("script[src]")) as HTMLScriptElement[]) {
    const reference = script.getAttribute("src") ?? "";
    const path = archivePath(entryPath, reference);
    if (!path) continue;
    const scriptFile = files[path];
    if (!scriptFile) throw new Error(`The archive is missing game script ${reference}.`);
    const scriptSource = await scriptFile.async("string");
    reserveArchiveBytes(budget, new TextEncoder().encode(scriptSource).byteLength);
    if (script.type === "module" && /\b(?:import|export)\s*(?:\(|[{*A-Za-z_$])/m.test(scriptSource)) {
      throw new Error("This project uses JavaScript modules. Bundle modules into a single offline script before importing.");
    }
    script.removeAttribute("src");
    script.removeAttribute("integrity");
    script.removeAttribute("crossorigin");
    script.textContent = scriptSource.replace(/<\/script/gi, "<\\/script");
  }
  for (const script of Array.from(document.querySelectorAll("script"))) {
    script.textContent = await inlineArchiveScriptMediaSources(script.textContent ?? "", entryPath, files, budget);
  }

  for (const link of Array.from(document.querySelectorAll("link[href]"))) {
    const rel = (link.getAttribute("rel") ?? "").toLowerCase().split(/\s+/);
    const reference = link.getAttribute("href") ?? "";
    const path = archivePath(entryPath, reference);
    if (!path) continue;
    const target = files[path];
    if (!target) throw new Error(`The archive is missing linked file ${reference}.`);
    if (rel.includes("stylesheet")) {
      const style = document.createElement("style");
      const stylesheet = await target.async("string");
      reserveArchiveBytes(budget, new TextEncoder().encode(stylesheet).byteLength);
      style.textContent = await inlineArchiveCss(stylesheet, path, files, new Set(), budget);
      link.replaceWith(style);
    } else {
      const bytes = await target.async("uint8array");
      reserveArchiveBytes(budget, Math.ceil(bytes.byteLength * 4 / 3) + 64);
      link.setAttribute("href", `data:${mimeType(path)};base64,${toBase64(bytes)}`);
    }
  }

  for (const style of Array.from(document.querySelectorAll("style"))) {
    style.textContent = await inlineArchiveCss(style.textContent ?? "", entryPath, files, new Set(), budget);
  }
  for (const element of Array.from(document.querySelectorAll("[src], [poster], [data]"))) {
    for (const attribute of ["src", "poster", "data"]) {
      if (!element.hasAttribute(attribute)) continue;
      const reference = element.getAttribute(attribute) ?? "";
      const path = archivePath(entryPath, reference);
      if (!path) continue;
      const target = files[path];
      if (!target) throw new Error(`The archive is missing game asset ${reference}.`);
      const bytes = await target.async("uint8array");
      reserveArchiveBytes(budget, Math.ceil(bytes.byteLength * 4 / 3) + 64);
      element.setAttribute(attribute, `data:${mimeType(path)};base64,${toBase64(bytes)}`);
    }
  }
  for (const element of Array.from(document.querySelectorAll("[style]"))) {
    element.setAttribute("style", await inlineArchiveCss(element.getAttribute("style") ?? "", entryPath, files, new Set(), budget));
  }
  for (const element of Array.from(document.querySelectorAll("[srcset]"))) {
    const srcset = element.getAttribute("srcset") ?? "";
    const candidates = srcset.split(",").map((candidate) => candidate.trim()).filter(Boolean);
    const rewritten: string[] = [];
    for (const candidate of candidates) {
      const [reference, ...descriptor] = candidate.split(/\s+/);
      const path = archivePath(entryPath, reference);
      if (!path) {
        rewritten.push(candidate);
        continue;
      }
      const target = files[path];
      if (!target) throw new Error(`The archive is missing image ${reference}.`);
      const bytes = await target.async("uint8array");
      reserveArchiveBytes(budget, Math.ceil(bytes.byteLength * 4 / 3) + 64);
      rewritten.push(`data:${mimeType(path)};base64,${toBase64(bytes)}${descriptor.length ? ` ${descriptor.join(" ")}` : ""}`);
    }
    element.setAttribute("srcset", rewritten.join(", "));
  }

  neutralizeOfflineNavigation(document);
  source = `<!doctype html>${document.documentElement.outerHTML}`;
  const issue = htmlSafetyIssue(source);
  if (issue) throw new Error(issue);
  return source;
}

function toBase64(bytes: Uint8Array) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong. Try importing the file again.";
}

function isStoredImportedGame(value: unknown): value is ImportedGame {
  if (!value || typeof value !== "object") return false;
  const game = value as Partial<ImportedGame>;
  if (
    typeof game.id !== "string" ||
    typeof game.name !== "string" ||
    typeof game.source !== "string" ||
    typeof game.addedAt !== "number"
  ) return false;

  if (game.kind === "html") {
    return (game.provenance === undefined || isRepositoryProvenance(game.provenance)) &&
      htmlSafetyIssue(game.source) === null &&
      importedRevisionMetadataValid(game, source => htmlSafetyIssue(source) === null) &&
      (game.revisionUndoSource === undefined ||
        (typeof game.revisionUndoSource === "string" && htmlSafetyIssue(game.revisionUndoSource) === null));
  }
  if (game.kind === "nes") {
    try {
      const bytes = fromBase64(game.source);
      return bytes.length <= MAX_ROM_BYTES &&
        bytes[0] === 0x4e && bytes[1] === 0x45 && bytes[2] === 0x53 && bytes[3] === 0x1a;
    } catch {
      return false;
    }
  }
  if (game.kind === "emulator") {
    return isArcadeEmulatorSystemId(game.system) &&
      game.romData instanceof ArrayBuffer &&
      game.romData.byteLength >= 16 &&
      game.romData.byteLength <= MAX_EMULATOR_ROM_BYTES &&
      detectArcadeEmulatorSystem(game.name) === game.system;
  }
  if (game.kind === "chip8") {
    const dialect = game.chip8Dialect ?? "chip8";
    return isChip8Dialect(dialect) && chip8DialectForFile(game.name, dialect) === dialect &&
      game.romData instanceof ArrayBuffer &&
      game.romData.byteLength >= 2 &&
      game.romData.byteLength <= MAX_CHIP8_ROM_BYTES &&
      (dialect === "schip" || game.romData.byteLength % 2 === 0);
  }
  return false;
}

export default function ImportedGameWorkspace({ onReviseSource, onUseRemakePrompt, onNativeInstalled, workshopLaunch = null, onExitWorkshop }: ImportedGameWorkspaceProps & { onNativeInstalled?: () => void }) {
  const [games, setGames] = useState<ImportedGame[]>([]);
  const currentGames = useRef<ImportedGame[]>([]);
  const persistedGames = useRef<ImportedGame[]>([]);
  const shelfWrites = useRef<Promise<void>>(Promise.resolve());
  const shelfMounted = useRef(false);
  const shelfReadGeneration = useRef(0);
  const [unsavedIds, setUnsavedIds] = useState<string[]>([]);
  const [savingShelf, setSavingShelf] = useState(0);
  const [externalShelfChange, setExternalShelfChange] = useState(false);
  const [refreshingShelf, setRefreshingShelf] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [selectedId, setSelectedId] = useState("");
  const [rightsAccepted, setRightsAccepted] = useState(false);
  const [description, setDescription] = useState("");
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [reaAnalysisBusy, setReaAnalysisBusy] = useState(false);
  const [reaAnalysisError, setReaAnalysisError] = useState("");
  const [reaAnalysis, setReaAnalysis] = useState<{ gameId: string; report: ReaGameAnalysis } | null>(null);
  const [reaAuthorizedForId, setReaAuthorizedForId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [chip8ImportDialect, setChip8ImportDialect] = useState<Chip8Dialect>("chip8");
  const [nesSaveAvailable, setNesSaveAvailable] = useState(false);
  const [nesSaveMessage, setNesSaveMessage] = useState("");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const htmlFrameRef = useRef<HTMLIFrameElement>(null);
  const nesRef = useRef<NES | null>(null);
  const revisionAbortRef = useRef<AbortController | null>(null);
  const buttonsRef = useRef<Map<string, ButtonKey>>(new Map());
  const selected = games.find((game) => game.id === selectedId) ?? null;
  // Mod profile playback binds only after the shelf loads and only for the
  // matching base game. Base source, revisions and shelf records stay intact.
  const workshopActive = !!(workshopLaunch && loaded && selected && workshopLaunch.gameId === selected.id);
  const runtimeGame = useMemo<ImportedGame | null>(() => {
    if (!selected) return null;
    if (!workshopActive || !workshopLaunch) return selected;
    return { ...selected, source: workshopLaunch.source, romData: workshopLaunch.romData ?? selected.romData };
  }, [selected, workshopActive, workshopLaunch]);
  const runtimeSaveId = workshopActive && workshopLaunch ? workshopLaunch.saveId : selected?.id ?? "";
  const onExitWorkshopRef = useRef(onExitWorkshop);
  onExitWorkshopRef.current = onExitWorkshop;
  const alignedLaunch = useRef<WorkshopPlayback | null>(null);
  useEffect(() => {
    if (!workshopLaunch) { alignedLaunch.current = null; return; }
    if (!loaded) return;
    if (alignedLaunch.current !== workshopLaunch) {
      if (games.some((game) => game.id === workshopLaunch.gameId)) {
        alignedLaunch.current = workshopLaunch;
        setSelectedId(workshopLaunch.gameId);
      } else {
        setError("The mod profile's base game is no longer on this shelf, so the profile was not launched.");
        onExitWorkshopRef.current?.();
      }
      return;
    }
    // Switching to another game always leaves the profile.
    if (selectedId && selectedId !== workshopLaunch.gameId) onExitWorkshopRef.current?.();
  }, [workshopLaunch, loaded, selectedId, games]);
  const managedDescriptor = useMemo<ArcadeGameDescriptor | null>(() => selected ? {
    id: selected.id, title: selected.name, source: selected.romData ?? selected.source,
    format: selected.kind === "html" ? "html" : selected.kind === "nes" ? "ines" : selected.kind === "chip8" ? "chip8" : `emulatorjs:${selected.system}`,
    profile: selected.kind === "chip8" ? selected.chip8Dialect ?? "chip8" : selected.system ?? selected.kind,
    scope: "imported-private", trust: selected.kind === "html" ? "imported-code" : "rom", saveId: runtimeSaveId,
    ...(workshopActive && workshopLaunch ? { workshop: { profileId: workshopLaunch.profileId, modKeys: workshopLaunch.modKeys, saveScope: runtimeSaveId === selected.id ? "shared" as const : "isolated" as const } } : {}),
    stored: savingShelf === 0 && !unsavedIds.includes(selected.id), addedAt: selected.addedAt,
    sourceRevisionCopies: selected.kind === "html" ? getImportedRevisionHistory(selected).length : 0,
    provenance: selected.provenance,
  } : null, [selected, savingShelf, unsavedIds, workshopActive, workshopLaunch, runtimeSaveId]);
  const management = useArcadeManagement(managedDescriptor);
  const revisionCopies = useMemo(() => selected?.kind === "html"
    ? getImportedRevisionHistory(selected).map(copy => ({ ...copy, sizeKb: Math.ceil(new Blob([copy.source]).size / 1024) }))
    : [], [selected?.kind, selected?.source, selected?.revisionRollback, selected?.revisionHistory]);
  const selectedEmulatorRom = useMemo(
    () => (runtimeGame?.kind === "emulator" || runtimeGame?.kind === "chip8") && runtimeGame.romData instanceof ArrayBuffer
      ? runtimeGame.romData
      : null,
    [runtimeGame],
  );
  const compactHtml = useMemo(
    () => selected?.kind === "html" ? maskEmbeddedAssets(withoutRepositoryAttribution(selected.source)) : null,
    [selected?.id, selected?.source],
  );
  const gameSaves = useArcadeGameSave(
    htmlFrameRef,
    selected?.kind === "html" ? runtimeSaveId || null : null,
  );
  // Save-indicator updates must not regenerate srcDoc with newly saved bytes:
  // changing that attribute navigates the iframe and resets live gameplay.
  const selectedHtmlDocument = useMemo(
    () => runtimeGame?.kind === "html" ? browserHtmlAdapter.launch({
      source: runtimeGame.source, saveId: runtimeSaveId, sessionId: gameSaves.sessionId, revision: gameSaves.initialRevision,
    }) : "",
    [runtimeGame?.kind, runtimeSaveId, runtimeGame?.source, gameSaves.reloadKey, gameSaves.sessionId, gameSaves.initialRevision],
  );

  useEffect(() => () => revisionAbortRef.current?.abort(), []);

  useEffect(() => {
    if (!selected || selected.kind !== "nes") {
      setNesSaveAvailable(false);
      setNesSaveMessage("");
      return;
    }
    let active = true;
    readNesSaveState(runtimeSaveId).then((state) => {
      if (active) setNesSaveAvailable(state !== null);
    }).catch(() => {
      if (active) setNesSaveMessage("Local save-state storage is unavailable in this browser.");
    });
    return () => { active = false; };
  }, [selected?.id, selected?.kind, runtimeSaveId]);

  const saveNesProgress = async () => {
    if (!selected || selected.kind !== "nes" || !nesRef.current) return;
    try {
      await writeNesSaveState(runtimeSaveId, nesRef.current.toJSON());
      setNesSaveAvailable(true);
      setNesSaveMessage("Progress saved on this browser.");
    } catch (cause) {
      setNesSaveMessage(errorMessage(cause));
    }
  };

  const loadNesProgress = async () => {
    if (!selected || selected.kind !== "nes" || !nesRef.current) return;
    try {
      const state = await readNesSaveState(runtimeSaveId);
      if (!state) throw new Error("There is no saved progress for this game yet.");
      nesRef.current.fromJSON(state as any);
      setNesSaveMessage("Saved progress restored.");
    } catch (cause) {
      setNesSaveMessage(errorMessage(cause));
    }
  };

  const clearNesProgress = async () => {
    if (!selected || selected.kind !== "nes") return;
    try {
      await deleteNesSaveState(runtimeSaveId);
      setNesSaveAvailable(false);
      setNesSaveMessage("Saved progress cleared from this browser.");
    } catch (cause) {
      setNesSaveMessage(errorMessage(cause));
    }
  };

  const setShelfGames = useCallback((next: ImportedGame[]) => {
    currentGames.current = next;
    setGames(next);
  }, []);

  const refreshSavedShelf = useCallback(async (discardLocal = false, changedIds?: string[]) => {
    const generation = ++shelfReadGeneration.current;
    const confirmedSnapshot = currentGames.current;
    await shelfWrites.current;
    const baseline = persistedGames.current;
    const stored = changedIds ? await loadImportedGameRecords(changedIds) : await loadImportedGames();
    if (!shelfMounted.current || generation !== shelfReadGeneration.current) return false;
    // Never apply a read that raced a newer local commit or new work created
    // after the user confirmed discarding a particular snapshot.
    if (persistedGames.current !== baseline || (discardLocal && currentGames.current !== confirmedSnapshot)) {
      setExternalShelfChange(true);
      return false;
    }
    const dirty = importedGameStorageChanges(persistedGames.current, currentGames.current);
    if (!discardLocal && (dirty.upsert.length || dirty.remove.length)) {
      setExternalShelfChange(true);
      return false;
    }
    const existing = new Map(currentGames.current.map((game) => [game.id, game]));
    const changed = new Set(changedIds);
    const candidates = changedIds ? [...baseline.filter((game) => !changed.has(game.id)), ...stored] : stored;
    const valid = candidates.filter(isStoredImportedGame).map((game) => {
      const current = existing.get(game.id);
      // Keep unchanged player/ROM identities: another tab adding an unrelated
      // game must not restart the currently running emulator.
      return current && importedGameRecordsMatch(current, game) ? current : game;
    }).sort((a, b) => b.addedAt - a.addedAt);
    persistedGames.current = valid;
    setShelfGames(valid);
    setUnsavedIds([]);
    setExternalShelfChange(false);
    setSelectedId((current) => valid.some((game) => game.id === current) ? current : valid[0]?.id ?? "");
    setLoaded(true);
    return true;
  }, [setShelfGames]);

  useEffect(() => {
    shelfMounted.current = true;
    let active = true;
    let refreshQueue = Promise.resolve();
    const refresh = (ids?: string[]) => {
      // Preserve every notification's changed IDs even when consecutive
      // transactions arrive while an earlier partial read is still pending.
      refreshQueue = refreshQueue.then(async () => {
        if (active) await refreshSavedShelf(false, ids);
      }).catch(() => {
        if (!active || !shelfMounted.current) return;
        setLoaded(true);
        setExternalShelfChange(true);
        setError("Your local game shelf could not be read. Existing saved games have not been removed.");
      });
    };
    const unsubscribe = subscribeImportedGamesChanged(refresh);
    refresh();
    return () => {
      active = false;
      shelfMounted.current = false;
      shelfReadGeneration.current++;
      unsubscribe();
    };
  }, [refreshSavedShelf]);

  const saveGames = useCallback(async (next: ImportedGame[], optimistic = true, failureMessage?: string) => {
    if (optimistic) setShelfGames(next);
    setSavingShelf((count) => count + 1);
    const operation = shelfWrites.current.then(async () => {
      await saveImportedGameChanges(persistedGames.current, next);
      persistedGames.current = next;
    });
    shelfWrites.current = operation.catch(() => {});
    try {
      await operation;
      if (!optimistic) setShelfGames(next);
      return true;
    } catch (cause) {
      if (cause instanceof ImportedGameStorageConflictError) {
        setExternalShelfChange(true);
        setError(cause.message);
        return false;
      }
      const quota = cause instanceof Error && cause.name === "QuotaExceededError";
      setError(`${failureMessage ?? (optimistic ? "The game is available for this session, but it could not be saved." : "The game could not be removed. It remains on your shelf.")} Previously saved records are unchanged.${quota ? " Browser storage is full; free space and retry." : ""}`);
      return false;
    } finally {
      if (shelfMounted.current) {
        setSavingShelf((count) => count - 1);
        setUnsavedIds(importedGameStorageChanges(persistedGames.current, currentGames.current).upsert.map((game) => game.id));
      }
    }
  }, [setShelfGames]);

  const retryShelfSave = async () => {
    if (savingShelf || busy || removing || refreshingShelf) return;
    setError("");
    setNotice("");
    if (await saveGames(currentGames.current)) {
      setNotice("Your unsaved games are now saved on this device.");
      await refreshSavedShelf().catch(() => setExternalShelfChange(true));
    }
  };

  const restoreSourceBackup = async (game: SourceBackupGame, expected: { id: string; name: string } | undefined) => {
    if (!loaded || !rightsAccepted || busy || removing || refreshingShelf || savingShelf || workshopActive) return false;
    const existing = currentGames.current.find(record => record.id === game.id);
    if (existing !== expected) {
      setError("This game changed since the backup preview. Choose the backup again before restoring.");
      return false;
    }
    if (!existing && currentGames.current.length >= 12) {
      setError("Your local shelf is full. Remove a game before restoring another.");
      return false;
    }
    if (unsavedIds.length || externalShelfChange) {
      setError("Save your unsaved games or refresh the saved shelf before restoring source.");
      return false;
    }
    const next = existing ? currentGames.current.map(record => record.id === game.id ? game : record) : [game, ...currentGames.current];
    if (!await saveGames(next, false, "Source backup could not be saved. Active source and rollback copies are unchanged.")) return false;
    setError("");
    setSelectedId(game.id);
    return true;
  };

  const reloadSavedShelf = async () => {
    if (savingShelf || busy || removing || refreshingShelf) return;
    const dirty = importedGameStorageChanges(persistedGames.current, currentGames.current);
    if ((dirty.upsert.length || dirty.remove.length) &&
      !window.confirm("Discard this tab’s unsaved game changes and load the saved shelf? Already saved games will not be deleted.")) return;
    setRefreshingShelf(true);
    try {
      if (await refreshSavedShelf(true)) {
        setError("");
        setNotice("The latest saved shelf is loaded.");
      }
    } catch {
      setError("Could not refresh the saved shelf. Your current games are still available.");
    } finally { setRefreshingShelf(false); }
  };

  useEffect(() => {
    if (!runtimeGame || runtimeGame.kind !== "nes" || !canvasRef.current || !management.manifest || !management.compatibility?.available) {
      nesRef.current = null;
      return;
    }
    let active = true;
    let animation = 0;
    let batteryFlush = 0;
    let flushBatteryRam = () => {};
    const start = async () => {
      try {
        if (!active) return;
        const canvas = canvasRef.current;
        if (!canvas) return;
        const context = canvas.getContext("2d", { alpha: false });
        if (!context) throw new Error("Canvas rendering is unavailable in this browser.");
        const pixels = context.createImageData(256, 240);
        const packedPixels = new Uint32Array(pixels.data.buffer);
        const batteryRam = new Uint8Array(0x2000);
        const batteryKey = `arenaforge.nes-sram.v1:${runtimeSaveId}`;
        try {
          const encodedRam = localStorage.getItem(batteryKey);
          if (encodedRam) {
            const savedRam = fromBase64(encodedRam);
            batteryRam.set(savedRam.subarray(0, batteryRam.length));
          }
        } catch {}
        let batteryDirty = false;
        flushBatteryRam = () => {
          if (!batteryDirty) return;
          batteryDirty = false;
          try {
            localStorage.setItem(batteryKey, toBase64(batteryRam));
          } catch {
            setError("The NES game ran, but browser storage could not save its battery-backed progress.");
          }
        };
        const nes = await browserNesAdapter.launch({ binary: atob(runtimeGame.source), options: {
          onFrame: (frame) => {
            for (let i = 0; i < frame.length; i += 1) {
              packedPixels[i] = 0xff000000 | (frame[i] ?? 0);
            }
            context.putImageData(pixels, 0, 0);
          },
          onAudioSample: () => undefined,
          onBatteryRamWrite: (address, value) => {
            const offset = address - 0x6000;
            if (offset < 0 || offset >= batteryRam.length) return;
            batteryRam[offset] = value & 0xff;
            batteryDirty = true;
            window.clearTimeout(batteryFlush);
            batteryFlush = window.setTimeout(flushBatteryRam, 250);
          },
        } });
        const cpuMemory = (nes as unknown as { cpu?: { mem?: Uint8Array } }).cpu?.mem;
        if (cpuMemory) cpuMemory.set(batteryRam, 0x6000);
        try {
          const savedState = await readNesSaveState(runtimeSaveId);
          if (active && savedState) {
            nes.fromJSON(savedState as any);
            setNesSaveAvailable(true);
          }
        } catch {
          if (active) setNesSaveMessage("This browser could not restore the local save state.");
        }
        if (!active) return;
        if (!active) { browserNesAdapter.cleanup(Promise.resolve(nes)); return; }
        nesRef.current = nes;
        const tick = () => {
          if (!active) return;
          try {
            nes.frame();
          } catch (cause) {
            active = false;
            setError(`The emulator stopped: ${errorMessage(cause)}`);
            return;
          }
          animation = window.setTimeout(tick, 1000 / 60);
        };
        tick();
        // Import/selection actions already clear errors. Async startup must not
        // erase a newer import failure or an error reported by the first frame.
      } catch (cause) {
        if (active) setError(`This ROM could not be started: ${errorMessage(cause)}`);
      }
    };
    void start();
    return () => {
      active = false;
      window.clearTimeout(animation);
      window.clearTimeout(batteryFlush);
      flushBatteryRam();
      if (nesRef.current) browserNesAdapter.cleanup(Promise.resolve(nesRef.current));
      nesRef.current = null;
      buttonsRef.current.clear();
    };
  }, [runtimeGame, runtimeSaveId, management.manifest?.installedVersion, management.compatibility?.available]);

  const handleImport = async (file: File | undefined, kind: "html" | "nes" | "emulator" | "chip8", provenance?: ArcadeRepositoryProvenance): Promise<boolean> => {
    if (!file) return false;
    setError("");
    setNotice("");
    if (!rightsAccepted) {
      setError("Accept the rights statement before importing a game.");
      return false;
    }
    try {
      if (currentGames.current.length >= 12) throw new Error("Your local shelf is full. Remove a game before importing another.");
      if (kind === "html") {
        const isArchive = file.name.toLowerCase().endsWith(".zip") || file.type === "application/zip";
        if (isArchive && file.size > MAX_ARCHIVE_BYTES) throw new Error("Game archives are limited to 3 MB compressed.");
        if (!isArchive && file.size > MAX_HTML_BYTES) throw new Error("HTML files are limited to 6 MB.");
        const rawSource = isArchive ? await bundleOfflineBrowserGame(file) : prepareOfflineHtml(await file.text());
        const recoveredProvenance = resolveRepositoryAttribution(rawSource, provenance);
        const source = withRepositoryAttribution(rawSource, recoveredProvenance);
        const issue = htmlSafetyIssue(source);
        if (issue) throw new Error(issue);
        const game: ImportedGame = { id: crypto.randomUUID(), name: file.name, kind, source, addedAt: Date.now(), ...(recoveredProvenance ? { provenance: recoveredProvenance } : {}) };
        if (currentGames.current.length >= 12) throw new Error("Your local shelf filled while importing. Remove a game and retry.");
        const next = [game, ...currentGames.current];
        await saveGames(next);
        setSelectedId(game.id);
        setNotice("Imported locally. The game stays in this browser only.");
        return true;
      }
      if (kind === "emulator") {
        const system = detectArcadeEmulatorSystem(file.name);
        if (!system) {
          throw new Error("Unsupported ROM extension. Arcade currently supports GB/GBC, GBA, SNES, Mega Drive, Master System, Game Gear, and N64 files.");
        }
        if (file.size < 16 || file.size > MAX_EMULATOR_ROM_BYTES) {
          throw new Error("Console ROMs must be between 16 bytes and 64 MB.");
        }
        const romData = await file.arrayBuffer();
        const game: ImportedGame = {
          id: crypto.randomUUID(),
          name: file.name,
          kind,
          system,
          source: "",
          romData,
          addedAt: Date.now(),
        };
        await saveGames([game, ...currentGames.current].slice(0, 12));
        setSelectedId(game.id);
        setNotice(`${arcadeEmulatorSystemLabel(system)} game imported to this browser's local shelf.`);
        return true;
      }
      if (kind === "chip8") {
        const dialect = chip8DialectForFile(file.name, chip8ImportDialect);
        if (!dialect) {
          throw new Error("CHIP-8 imports use .ch8/.c8; Super-CHIP also accepts .sc8/.sch8.");
        }
        if (file.size < 2 || file.size > MAX_CHIP8_ROM_BYTES || (dialect === "chip8" && file.size % 2 !== 0)) {
          throw new Error(`${chip8DialectLabel(dialect)} programs must be ${dialect === "chip8" ? "even-sized and " : ""}between 2 bytes and ${MAX_CHIP8_ROM_BYTES} bytes.`);
        }
        const romData = await file.arrayBuffer();
        const game: ImportedGame = {
          id: crypto.randomUUID(),
          name: file.name,
          kind,
          chip8Dialect: dialect,
          source: "",
          romData,
          addedAt: Date.now(),
        };
        await saveGames([game, ...currentGames.current].slice(0, 12));
        setSelectedId(game.id);
        setNotice(`${chip8DialectLabel(dialect)} program imported to this browser's local shelf.`);
        return true;
      }
      if (file.size < 16 || file.size > MAX_ROM_BYTES) throw new Error("NES ROMs must be between 16 bytes and 1 MB.");
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (bytes[0] !== 0x4e || bytes[1] !== 0x45 || bytes[2] !== 0x53 || bytes[3] !== 0x1a) {
        throw new Error("This does not look like an iNES-format homebrew ROM.");
      }
      const source = toBase64(bytes);
      const game: ImportedGame = { id: crypto.randomUUID(), name: file.name, kind, source, addedAt: Date.now() };
      await saveGames([game, ...currentGames.current].slice(0, 12));
      setSelectedId(game.id);
      setNotice("ROM imported to this browser's local shelf.");
      return true;
    } catch (cause) {
      setError(errorMessage(cause));
      return false;
    }
  };

  const exportSelectedHtml = () => {
    if (selected?.kind !== "html") return;
    let url: string | undefined;
    const link = document.createElement("a");
    try {
      const source = withRepositoryAttribution(selected.source, selected.provenance);
      url = URL.createObjectURL(new Blob([source], { type: "text/html;charset=utf-8" }));
      link.href = url;
      const name = selected.name.replace(/\.(?:zip|html?)$/i, "").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").slice(0, 120);
      link.download = `${name || "arcade-game"}.html`;
      document.body.appendChild(link);
      link.click();
      setError("");
      setNotice("HTML source exported with its source notices. Local game-save progress is not included.");
    } catch (cause) {
      setError(`The game could not be exported: ${errorMessage(cause)}`);
    } finally {
      link.remove();
      if (url) window.setTimeout(() => URL.revokeObjectURL(url!), 1000);
    }
  };

  const applyHtmlRevision = async (expected: ImportedGame, source: string, label: string) => {
    const id = expected.id;
    const current = currentGames.current.find((game) => game.id === id);
    if (!current || current.kind !== "html" || !importedGameRecordsMatch(expected, current)) {
      throw new Error("This game changed while the revision was running. Review the current version and retry.");
    }
    if (current.revisionUndoSource !== undefined) throw new Error("Keep or undo the current revision first.");
    const provenance = resolveRepositoryAttribution(current.source, current.provenance);
    const attributed = withRepositoryAttribution(source, provenance);
    const issue = htmlSafetyIssue(attributed);
    if (issue) { setError(`Revision not applied: ${issue}`); return false; }
    const next = currentGames.current.map((game) => game.id === id
      ? { ...game, source: attributed, ...(provenance ? { provenance } : {}), revisionUndoSource: game.source, revisionUndoLabel: game.revisionLabel, revisionLabel: label.slice(0, 120) }
      : game);
    const saved = await saveGames(next, false, "The revision could not be saved. Active source and rollback copies are unchanged.");
    if (!saved) return false;
    gameSaves.reloadGame();
    setReaAnalysis((current) => current?.gameId === id ? null : current);
    return saved;
  };

  const keepHtmlRevision = async () => {
    if (workshopActive) { setError("Leave the mod profile before changing or removing the base game."); return; }
    if (busy || savingShelf || !selected || selected.kind !== "html" || selected.revisionUndoSource === undefined) return;
    setError(""); setNotice("");
    const next = currentGames.current.map((game) => {
      if (game.id !== selected.id || game.kind !== "html" || game.revisionUndoSource === undefined) return game;
      return keepImportedRevision(game);
    });
    if (await saveGames(next, false, "The revision could not be kept. The pending undo and previous version remain available.")) {
      setNotice("Revision kept. The previous version is saved locally for restoration. Your saved progress is unchanged.");
    }
  };

  const undoHtmlRevision = async () => {
    if (workshopActive) { setError("Leave the mod profile before changing or removing the base game."); return; }
    if (busy || savingShelf || !selected || selected.kind !== "html" || selected.revisionUndoSource === undefined) return;
    setError(""); setNotice("");
    const next = currentGames.current.map((game) => {
      if (game.id !== selected.id || game.kind !== "html" || game.revisionUndoSource === undefined) return game;
      return undoImportedRevision(game);
    });
    if (!await saveGames(next, false, "Undo could not be saved. Active source and rollback copies are unchanged.")) return;
    gameSaves.reloadGame();
    setReaAnalysis((current) => current?.gameId === selected.id ? null : current);
    setNotice("Earlier game source restored. Your saved progress is unchanged.");
  };

  const restoreHtmlRevision = async (index = 0) => {
    if (workshopActive) { setError("Leave the mod profile before changing or removing the base game."); return; }
    if (busy || savingShelf || !selected || selected.kind !== "html" || selected.revisionUndoSource !== undefined || !revisionCopies[index]) return;
    setError(""); setNotice("");
    const current = currentGames.current.find(game => game.id === selected.id);
    if (!importedGameRecordsMatch(selected, current)) {
      setError("This game changed. Review its current history before restoring a version.");
      return;
    }
    const next = currentGames.current.map(game => game.id === selected.id ? restoreImportedRevision(game, Date.now(), index) : game);
    if (!await saveGames(next, false, "The previous version could not be restored. Active source and rollback copies are unchanged.")) return;
    gameSaves.reloadGame();
    setReaAnalysis(current => current?.gameId === selected.id ? null : current);
    setNotice(`${index === 0 ? "Previous version" : "Earlier version"} restored. The replaced source is now the rollback copy. Your saved progress is unchanged.`);
  };

  const revise = async () => {
    if (workshopActive) { setError("Leave the mod profile before changing or removing the base game."); return; }
    if (!selected || selected.kind !== "html" || !instruction.trim() || busy || savingShelf) return;
    const controller = new AbortController();
    revisionAbortRef.current = controller;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (!compactHtml || compactHtml.source.length > 50_000) {
        throw new Error("Game code sent for revision is limited to 50 KB after bundled media is removed.");
      }
      const modelRevision = await onReviseSource(compactHtml.source, instruction.trim(), controller.signal);
      if (controller.signal.aborted) {
        const aborted = new Error("Revision cancelled.");
        aborted.name = "AbortError";
        throw aborted;
      }
      const revised = restoreEmbeddedAssets(modelRevision, compactHtml.assets);
      if (typeof revised !== "string") throw new Error("The revision did not return HTML source.");
      const issue = htmlSafetyIssue(revised);
      if (issue) throw new Error(`Revision not applied: ${issue}`);
      if (selected.revisionUndoSource !== undefined) {
        throw new Error("Keep or undo the current revision before applying another.");
      }
      if (!await applyHtmlRevision(selected, revised, instruction.trim())) return;
      setInstruction("");
      setNotice("Revision applied. Play it, then keep it or undo it.");
    } catch (cause) {
      if (controller.signal.aborted || (cause instanceof Error && cause.name === "AbortError")) {
        setError("");
        setNotice("Revision cancelled. The imported game and its progress are unchanged.");
      } else {
        setError(`Revision failed: ${errorMessage(cause)}`);
      }
    } finally {
      if (revisionAbortRef.current === controller) revisionAbortRef.current = null;
      setBusy(false);
    }
  };

  const analyzeWithRea = async () => {
    if (!selected || selected.kind !== "html" || !compactHtml || reaAuthorizedForId !== selected.id || reaAnalysisBusy) return;
    setReaAnalysisBusy(true);
    setReaAnalysisError("");
    setReaAnalysis(null);
    try {
      const sourceBytes = new TextEncoder().encode(compactHtml.source).byteLength;
      if (sourceBytes > 50_000) {
        throw new Error("REA analysis is limited to 50 KB of game source after bundled media is removed.");
      }
      const gameId = selected.id;
      const response = await fetch("/api/arcade/import/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: compactHtml.source, authorized: true }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "REA analysis failed.");
      if (!body.analysis || typeof body.analysis !== "object") throw new Error("REA returned an incomplete report.");
      setReaAnalysis({ gameId, report: body.analysis as ReaGameAnalysis });
    } catch (cause) {
      setReaAnalysisError(errorMessage(cause));
    } finally {
      setReaAnalysisBusy(false);
    }
  };

  const addReaFindingsToPrompt = () => {
    if (!selected || !instruction.trim()) return;
    const report = reaAnalysis?.gameId === selected.id ? reaAnalysis.report : null;
    if (!report) return;
    const notes = [
      report.inputEvents.length ? `input events: ${report.inputEvents.join(", ")}` : "",
      report.gameLoopApis.length ? `update APIs: ${report.gameLoopApis.join(", ")}` : "",
      report.progressStores.length ? `progress storage: ${report.progressStores.join(", ")}` : "",
      report.functionNames.length ? `functions: ${report.functionNames.slice(0, 6).join(", ")}` : "",
      report.stateNames.length ? `state names: ${report.stateNames.slice(0, 8).join(", ")}` : "",
    ].filter(Boolean).join("; ");
    const context = `\n\nREA static findings (code-derived hints only; not proof of runtime behavior): ${notes || "No common gameplay signals were identified."}`;
    const next = `${instruction.trim()}${context}`;
    if (next.length > 1000) {
      setReaAnalysisError("Shorten your revision request before adding the REA notes; prompts are limited to 1,000 characters.");
      return;
    }
    setInstruction(next);
    setReaAnalysisError("");
    setNotice("REA findings were added to the revision prompt. Review them before applying the change.");
  };

  const removeSelected = async () => {
    if (workshopActive) { setError("Leave the mod profile before changing or removing the base game."); return; }
    if (!selected || removing || busy) return;
    const next = games.filter((game) => game.id !== selected.id);
    // Clear the removed game's error before the async storage write. A newer
    // import may start as soon as the row disappears; late cleanup must not
    // erase that import's validation feedback.
    setNotice("");
    setError("");
    setRemoving(true);
    try {
      if (!await saveGames(next, false)) return;
      setReaAnalysis((current) => current?.gameId === selected.id ? null : current);
      setSelectedId((current) => current === selected.id ? next[0]?.id ?? "" : current);
    } finally { setRemoving(false); }
  };

  const remakePrompt = useMemo(() => {
    if (!selected || selected.kind !== "nes" || !description.trim()) return "";
    return `Create a new, original browser game inspired only by this user description. The reference filename is ${selected.name}. Do not reproduce copyrighted names, characters, music, levels, graphics, or code. User description: ${description.trim()}`;
  }, [description, selected]);

  const setNesButton = useCallback((key: string, button: ButtonKey, pressed: boolean) => {
    const nes = nesRef.current;
    if (!nes) return;
    if (pressed) {
      if (buttonsRef.current.get(key) === button) return;
      const alreadyHeld = [...buttonsRef.current.values()].includes(button);
      buttonsRef.current.set(key, button);
      if (!alreadyHeld) nes.buttonDown(1, button);
    } else {
      if (!buttonsRef.current.delete(key)) return;
      if (![...buttonsRef.current.values()].includes(button)) nes.buttonUp(1, button);
    }
  }, []);

  const releaseNesButtons = useCallback(() => {
    // Only release on lifecycle boundaries, never on a timer: an intentional
    // long hold must keep working. At most eight controller buttons are sent.
    const held = new Set(buttonsRef.current.values());
    buttonsRef.current.clear();
    for (const button of held) nesRef.current?.buttonUp(1, button);
  }, []);

  useEffect(() => {
    if (!selected || selected.kind !== "nes") return;
    const keyMap: Record<string, ButtonKey> = {
      ArrowUp: BUTTON.UP, ArrowDown: BUTTON.DOWN,
      ArrowLeft: BUTTON.LEFT, ArrowRight: BUTTON.RIGHT,
      z: BUTTON.A, x: BUTTON.B,
      Enter: BUTTON.START, Shift: BUTTON.SELECT,
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select, button")) return;
      const button = keyMap[event.key] ?? keyMap[event.key.toLowerCase()];
      if (button === undefined) return;
      event.preventDefault();
      setNesButton(`key:${button}`, button, true);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      const button = keyMap[event.key] ?? keyMap[event.key.toLowerCase()];
      if (button !== undefined) setNesButton(`key:${button}`, button, false);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") releaseNesButtons();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", releaseNesButtons);
    window.addEventListener("pagehide", releaseNesButtons);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", releaseNesButtons);
      window.removeEventListener("pagehide", releaseNesButtons);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      releaseNesButtons();
    };
  }, [selected?.id, selected?.kind, setNesButton, releaseNesButtons]);

  const controls = [
    ["Up", BUTTON.UP], ["Down", BUTTON.DOWN],
    ["Left", BUTTON.LEFT], ["Right", BUTTON.RIGHT],
    ["B", BUTTON.B], ["A", BUTTON.A],
    ["Select", BUTTON.SELECT], ["Start", BUTTON.START],
  ] as const;

  return (
    <section className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_260px]" aria-label="Imported game workspace">
      <div className="min-w-0 space-y-4">
        <header className="glass rounded-2xl border border-white/10 p-4 sm:p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-[10px] font-black uppercase tracking-[0.22em] text-emerald-300">Local import bay</p>
              <h2 className="mt-1 text-xl font-black tracking-tight text-white">Bring your own game.</h2>
                <p className="mt-1 max-w-2xl text-xs leading-relaxed text-slate-400">
                CHIP-8 / Super-CHIP homebrew, homebrew NES, supported multi-system ROMs, and authorized HTML5 games. Imported game files stay in this browser. HTML runs in a restricted sandbox; multi-system cores download once from EmulatorJS and are cached locally.
              </p>
            </div>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-300/20 bg-emerald-300/10 px-2.5 py-1 text-[10px] font-bold text-emerald-200">
              <HardDrive size={12} /> Local shelf
            </span>
          </div>

          <label className="mt-4 flex cursor-pointer items-start gap-2 text-[11px] leading-relaxed text-slate-300">
            <input
              type="checkbox"
              checked={rightsAccepted}
              onChange={(event) => setRightsAccepted(event.target.checked)}
              className="mt-0.5 accent-emerald-400"
            />
            <span>{RIGHTS_COPY}</span>
          </label>

          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl border border-white/10 bg-black/20 p-3">
              <div className="flex items-start gap-2">
                <Gamepad2 className="mt-0.5 shrink-0 text-emerald-300" size={16} />
                <div>
                  <p className="text-xs font-extrabold text-slate-100">CHIP-8 / Super-CHIP homebrew</p>
                  <p className="mt-1 text-[11px] leading-relaxed text-slate-400">2 bytes–3.5 KB; no core download. .sc8/.sch8 select Super-CHIP automatically. Choose the dialect for .ch8/.c8 files.</p>
                </div>
              </div>
              <label className="mt-3 block text-[11px] text-slate-300">
                Program dialect
                <select
                  aria-label="CHIP-8 program dialect"
                  value={chip8ImportDialect}
                  onChange={event => { if (isChip8Dialect(event.target.value)) setChip8ImportDialect(event.target.value); }}
                  className="mt-1 block w-full rounded-md border border-white/15 bg-slate-950 px-2 py-2 text-xs text-slate-100"
                >
                  <option value="chip8">Classic CHIP-8 · 64×32</option>
                  <option value="schip">Super-CHIP (modern) · up to 128×64</option>
                </select>
              </label>
              <label className={`mt-3 inline-flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-xs font-extrabold transition ${rightsAccepted ? "border-emerald-300/20 bg-emerald-300/10 text-emerald-100 hover:bg-emerald-300/15" : "cursor-not-allowed border-white/5 bg-white/5 text-slate-500"}`}>
                <Upload size={14} /> Import CHIP-8 program
                <input
                  className="sr-only"
                  type="file"
                  accept=".ch8,.c8,.sc8,.sch8,application/octet-stream"
                  disabled={!rightsAccepted}
                  data-testid="input-chip8-rom"
                  onChange={(event) => { void handleImport(event.target.files?.[0], "chip8"); event.currentTarget.value = ""; }}
                />
              </label>
            </div>
            <div className="rounded-xl border border-white/10 bg-black/20 p-3">
              <div className="flex items-start gap-2">
                <ShieldCheck className="mt-0.5 shrink-0 text-emerald-300" size={16} />
                <div>
                  <p className="text-xs font-extrabold text-slate-100">Authorized browser HTML</p>
                  <p className="mt-1 text-[11px] leading-relaxed text-slate-400">Offline HTML or a ZIP with one game page and local assets. Maximum 6 MB unpacked.</p>
                </div>
              </div>
              <label className={`mt-3 inline-flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-xs font-extrabold transition ${rightsAccepted ? "bg-emerald-400 text-slate-950 hover:bg-emerald-300" : "cursor-not-allowed bg-white/5 text-slate-500"}`}>
                <Upload size={14} /> Import HTML / ZIP
                <input className="sr-only" type="file" accept=".html,.htm,.zip,text/html,application/zip" disabled={!rightsAccepted} onChange={(event) => { void handleImport(event.target.files?.[0], "html"); event.currentTarget.value = ""; }} />
              </label>
            </div>
            <div className="rounded-xl border border-white/10 bg-black/20 p-3">
              <div className="flex items-start gap-2">
                <Gamepad2 className="mt-0.5 shrink-0 text-cyan-300" size={16} />
                <div>
                  <p className="text-xs font-extrabold text-slate-100">Homebrew NES ROM</p>
                  <p className="mt-1 text-[11px] leading-relaxed text-slate-400">iNES or NES 2.0, up to 1 MB. Supported mapper IDs are listed below. ROM bytes are playable, not source-modifiable.</p>
                </div>
              </div>
              <label className="mt-3 inline-flex cursor-pointer items-center gap-2 rounded-lg border border-cyan-300/20 bg-cyan-300/10 px-3 py-2 text-xs font-extrabold text-cyan-100 hover:bg-cyan-300/15">
                <Upload size={14} /> Import NES ROM
                <input className="sr-only" type="file" accept=".nes,application/octet-stream" disabled={!rightsAccepted} onChange={(event) => { void handleImport(event.target.files?.[0], "nes"); event.currentTarget.value = ""; }} />
              </label>
            </div>
            <div className="rounded-xl border border-white/10 bg-black/20 p-3">
              <div className="flex items-start gap-2">
                <Gamepad2 className="mt-0.5 shrink-0 text-violet-300" size={16} />
                <div>
                  <p className="text-xs font-extrabold text-slate-100">Multi-system console ROM</p>
                  <p className="mt-1 text-[11px] leading-relaxed text-slate-400">
                    GB/GBC, GBA, SNES, Mega Drive, Master System, Game Gear, and N64 ROMs up to 64 MB. The selected core and save states are cached in this browser.
                  </p>
                </div>
              </div>
              <label className={`mt-3 inline-flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-xs font-extrabold transition ${rightsAccepted ? "border-violet-300/20 bg-violet-300/10 text-violet-100 hover:bg-violet-300/15" : "cursor-not-allowed border-white/5 bg-white/5 text-slate-500"}`}>
                <Upload size={14} /> Import multi-system ROM
                <input
                  className="sr-only"
                  type="file"
                  accept=".gb,.gbc,.gba,.sfc,.smc,.md,.gen,.sms,.gg,.n64,.z64,.v64,application/octet-stream"
                  disabled={!rightsAccepted}
                  data-testid="input-multisystem-rom"
                  onChange={(event) => { void handleImport(event.target.files?.[0], "emulator"); event.currentTarget.value = ""; }}
                />
              </label>
              <p className="mt-2 text-[9px] leading-relaxed text-slate-500">
                Prompt changes need editable source; these ROMs are play/save imports. EmulatorJS v4.2.3 ·{" "}
                <a href="https://github.com/EmulatorJS/EmulatorJS/blob/v4.2.3/LICENSE" target="_blank" rel="noreferrer" className="underline hover:text-violet-200">GPL-3.0</a>
              </p>
            </div>
          </div>
          <p className="mt-3 text-[10px] text-slate-500">12 saved games maximum. ROMs and progress stay in this browser; no commercial ROMs or assets are bundled with Arcade.</p>
        </header>

        {error && <div role="alert" className="flex items-start gap-2 rounded-xl border border-red-400/25 bg-red-500/10 px-3 py-2.5 text-xs leading-relaxed text-red-200"><AlertTriangle size={15} className="mt-0.5 shrink-0" />{error}</div>}
        {notice && !error && <div role="status" className="rounded-xl border border-emerald-400/20 bg-emerald-400/10 px-3 py-2.5 text-xs text-emerald-100">{notice}</div>}
        <ImportedGameSourceBackup selected={selected?.kind === "html" ? selected as SourceBackupGame : null}
          games={games} authorized={rightsAccepted}
          disabled={!loaded || busy || removing || refreshingShelf || savingShelf > 0 || workshopActive}
          onRestore={restoreSourceBackup} />
        <RepositoryGameImport disabled={!rightsAccepted || !loaded || busy || removing || games.length >= 12}
          onBuildSource={getNativeBridge()?.buildRepositorySource ? async token => {
            await getNativeBridge()!.buildRepositorySource!(token);
            onNativeInstalled?.();
          } : undefined}
          onInstallRelease={getNativeBridge()?.installRepositoryRelease ? async selection => {
            await getNativeBridge()!.installRepositoryRelease!(selection);
            onNativeInstalled?.();
          } : undefined}
          onImport={(file, provenance) => handleImport(file, "html", provenance)} />
        {selected?.provenance && <details className="rounded-xl border border-emerald-300/20 bg-black/20 p-3 text-xs text-slate-300" data-testid="imported-repository-provenance">
          <summary className="cursor-pointer font-bold text-emerald-100">Source and license · {selected.provenance.license.spdx}</summary>
          <p className="mt-2 break-all">{selected.provenance.repository} · {selected.provenance.revision}</p>
          <a className="underline" href={selected.provenance.sourceUrl} target="_blank" rel="noreferrer noopener" data-testid="link-pinned-repository">View pinned source</a>
          <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap">{selected.provenance.license.text}</pre>
        </details>}

        {selected ? (
          <div className="glass overflow-hidden rounded-2xl border border-white/10">
            <div className="flex flex-wrap items-center gap-2 border-b border-white/10 px-4 py-3">
              <span className={`rounded-full px-2 py-1 text-[9px] font-black uppercase tracking-wider ${selected.kind === "html" ? "bg-emerald-300/10 text-emerald-200" : "bg-cyan-300/10 text-cyan-200"}`}>
                {selected.kind === "html"
                  ? "Browser game"
                  : selected.kind === "nes"
                    ? "NES homebrew"
                    : selected.kind === "chip8"
                      ? chip8DialectLabel(selected.chip8Dialect ?? "chip8")
                      : selected.system ? arcadeEmulatorSystemLabel(selected.system) : "Console ROM"}
              </span>
              <h3 className="min-w-0 flex-1 truncate text-sm font-extrabold text-white">{selected.name}</h3>
              {selected.kind === "html" && <button type="button" onClick={exportSelectedHtml} disabled={removing || busy}
                data-testid="export-imported-html" title="Download editable HTML source and its license notices. Local game-save progress is not included."
                className="inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-[11px] font-bold text-emerald-200 hover:bg-emerald-300/10 disabled:opacity-40">
                <Download size={13} /> Export HTML source
              </button>}
              <button type="button" onClick={removeSelected} disabled={removing || busy || workshopActive} className="inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-[11px] font-bold text-slate-400 hover:bg-red-400/10 hover:text-red-200" aria-label={`Remove ${selected.name}`}>
                <Trash2 size={13} /> {removing ? "Removing…" : "Remove"}
              </button>
            </div>
            {workshopActive && workshopLaunch && (
              <div role="status" data-testid="workshop-profile-banner" className="flex flex-wrap items-center gap-2 border-b border-amber-300/20 bg-amber-300/[0.07] px-4 py-2.5 text-[11px] text-amber-100">
                <span className="rounded-full bg-amber-300/15 px-2 py-0.5 text-[9px] font-black uppercase tracking-wider">Mod profile</span>
                <span className="min-w-0 flex-1"><b>{workshopLaunch.profileName}</b> · {workshopLaunch.modKeys.length} mod{workshopLaunch.modKeys.length === 1 ? "" : "s"} · saves <span className="font-mono">{workshopLaunch.saveId}</span>. Base source, revisions and removal are locked while playing this profile.</span>
                <button type="button" data-testid="workshop-leave-profile" onClick={() => onExitWorkshop?.()} className="rounded-lg border border-amber-300/30 px-3 py-1.5 text-[10px] font-black hover:bg-amber-300/10">Leave profile · play base</button>
              </div>
            )}
            <ArcadeGameManagement management={management} />
            {!management.manifest ? <p role="status" className="p-3 text-xs text-slate-400">{management.error ? "Runtime metadata could not be prepared. Open diagnostics above to retry; source and saves are retained." : "Checking game runtime metadata…"}</p>
            : !management.compatibility?.available ? <p role="alert" className="p-3 text-xs text-amber-200">This game needs a compatible runtime. Open diagnostics above for the specific requirement; source and progress are retained.</p>
            : selected.kind === "html" ? (
              <div className="bg-black/30 p-2 sm:p-3">
                <iframe
                  key={`${runtimeSaveId}:${runtimeGame?.source.length ?? 0}:${gameSaves.reloadKey}`}
                  title={`Playable game: ${selected.name}`}
                  sandbox="allow-scripts"
                  allow="autoplay"
                  referrerPolicy="no-referrer"
                  ref={htmlFrameRef}
                  srcDoc={selectedHtmlDocument}
                  className="h-[min(68vh,620px)] min-h-[320px] w-full rounded-lg border border-white/10 bg-black"
                />
                {gameSaves.mediaPlaybackError && (
                  <p
                    role="alert"
                    data-testid="imported-audio-playback-error"
                    className="mt-2 rounded-lg border border-amber-300/25 bg-amber-300/[0.08] px-3 py-2 text-xs text-amber-100"
                  >
                    Game audio could not start ({gameSaves.mediaPlaybackError}). Click Play in the game again. If it still fails, check browser audio permissions and the selected output device.
                  </p>
                )}
                <div className="flex items-center justify-between gap-3 px-1 pt-2">
                  <p className="text-[10px] text-slate-500">
                    {gameSaves.persistenceWarning ? "Progress persistence needs attention." : `Progress saves in this browser${gameSaves.hasSavedProgress ? " · save data found" : ""}.`}
                  </p>
                  {(gameSaves.hasSavedProgress || gameSaves.persistenceWarning) && (
                    <button type="button" onClick={gameSaves.clearSavedProgress} className="text-[10px] font-bold text-slate-400 hover:text-red-200">
                      Clear progress
                    </button>
                  )}
                </div>
                <ArcadeSaveWarning
                  warning={gameSaves.persistenceWarning}
                  canRetry={gameSaves.canRetrySave}
                  conflict={gameSaves.hasRevisionConflict}
                  onRetry={gameSaves.retrySaving}
                  onReload={gameSaves.reloadGame}
                  onReconcile={gameSaves.reconcileStaleProgress}
                />
                <ImportedGameProgressBackup key={runtimeSaveId} game={workshopActive && runtimeGame ? { ...runtimeGame, id: runtimeSaveId } : selected} hasProgress={gameSaves.hasSavedProgress} disabled={busy || savingShelf > 0} onRestore={gameSaves.restoreSavedProgress} />
              </div>
            ) : selected.kind === "emulator" && selected.system && selectedEmulatorRom ? (
              <EmulatorJsPlayer
                key={runtimeSaveId}
                gameId={runtimeSaveId}
                name={selected.name}
                rom={selectedEmulatorRom}
                system={selected.system}
              />
            ) : selected.kind === "chip8" && selectedEmulatorRom ? (
              <Chip8Player
                key={runtimeSaveId}
                gameId={runtimeSaveId}
                name={selected.name}
                rom={selectedEmulatorRom}
                dialect={selected.chip8Dialect ?? "chip8"}
              />
            ) : (
              <div className="p-3">
                <div className="overflow-hidden rounded-xl border border-white/10 bg-[#10131b] p-3 sm:p-5">
                  <canvas ref={canvasRef} width={256} height={240} aria-label="NES game screen" className="mx-auto block w-full max-w-[512px] border border-white/10 bg-black [image-rendering:pixelated]" />
                  <p className="mt-2 text-center font-mono text-[9px] text-slate-500">Arrow keys move · Z / X action · Enter start · Shift select</p>
                </div>
                <div className="mx-auto mt-3 flex max-w-[430px] flex-wrap items-center justify-center gap-2" aria-label="Touch game controls">
                  {controls.map(([label, button]) => (
                    <button
                      key={label}
                      type="button"
                      onPointerDown={(event) => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); setNesButton(`pointer:${event.pointerId}`, button, true); }}
                      onPointerUp={(event) => setNesButton(`pointer:${event.pointerId}`, button, false)}
                      onPointerCancel={(event) => setNesButton(`pointer:${event.pointerId}`, button, false)}
                      onLostPointerCapture={(event) => setNesButton(`pointer:${event.pointerId}`, button, false)}
                      className={`touch-none rounded-lg border px-3 py-2 text-[10px] font-black uppercase tracking-wide active:translate-y-px ${label === "A" || label === "B" ? "border-rose-300/25 bg-rose-300/10 text-rose-100" : "border-white/10 bg-white/5 text-slate-200"}`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <p className="mt-2 text-center text-[10px] text-slate-500">
                  Battery-backed game progress saves in this browser. ROM files and saves stay on this device.
                </p>
                <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
                  <button type="button" onClick={() => void saveNesProgress()} className="rounded-lg border border-cyan-300/20 bg-cyan-300/10 px-3 py-2 text-[10px] font-bold text-cyan-100 hover:bg-cyan-300/15">
                    Save progress
                  </button>
                  <button type="button" onClick={() => void loadNesProgress()} disabled={!nesSaveAvailable} className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-[10px] font-bold text-slate-200 disabled:opacity-40">
                    Restore save
                  </button>
                  {nesSaveAvailable && (
                    <button type="button" onClick={() => void clearNesProgress()} className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-[10px] font-bold text-slate-300 hover:text-red-200">
                      Clear save
                    </button>
                  )}
                </div>
                {nesSaveMessage && <p role="status" className="mt-2 text-center text-[10px] text-slate-400">{nesSaveMessage}</p>}
              </div>
            )}
            {selected.kind === "html" && (
              <section className="border-t border-white/10 px-4 py-4" aria-label="Optional REA static analysis">
                <div className="rounded-xl border border-violet-300/20 bg-violet-300/[0.035] p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="text-xs font-extrabold text-violet-100">Optional REA game analysis</p>
                      <p className="mt-1 max-w-3xl text-[10px] leading-relaxed text-slate-400">
                        Clicking Analyze sends this game’s HTML to this Replit Arcade server for static JavaScript analysis. REA does not execute the game or send it to an AI service; temporary files are deleted after analysis, and the report stays only in this page session.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => void analyzeWithRea()}
                      disabled={reaAnalysisBusy || reaAuthorizedForId !== selected.id || !compactHtml || new TextEncoder().encode(compactHtml.source).byteLength > 50_000}
                      className="rounded-lg border border-violet-300/25 bg-violet-300/10 px-3 py-2 text-[10px] font-black text-violet-100 hover:bg-violet-300/15 disabled:cursor-not-allowed disabled:opacity-40"
                      data-testid="button-rea-analyze"
                    >
                      {reaAnalysisBusy ? "Analyzing source…" : "Analyze with REA"}
                    </button>
                  </div>
                  <label className="mt-3 flex cursor-pointer items-start gap-2 text-[10px] leading-relaxed text-slate-300">
                    <input
                      type="checkbox"
                      checked={reaAuthorizedForId === selected.id}
                      onChange={(event) => setReaAuthorizedForId(event.target.checked ? selected.id : null)}
                      className="mt-0.5 accent-violet-300"
                      data-testid="checkbox-rea-authorized"
                    />
                    <span>I own this game or have permission to analyze its source.</span>
                  </label>
                  {compactHtml && new TextEncoder().encode(compactHtml.source).byteLength > 50_000 && (
                    <p className="mt-2 text-[10px] text-amber-200">REA accepts up to 50 KB of source after bundled media is removed.</p>
                  )}
                  {reaAnalysisBusy && <p role="status" className="mt-2 text-[10px] text-violet-100">REA is parsing the source without running it.</p>}
                  {reaAnalysisError && <p role="alert" className="mt-2 text-[10px] text-red-200">{reaAnalysisError}</p>}
                  {reaAnalysis?.gameId === selected.id && (
                    <div className="mt-3 rounded-lg border border-white/10 bg-black/20 p-3" data-testid="rea-analysis-report">
                      <p className="text-[10px] font-black uppercase tracking-wider text-slate-200">Static source findings</p>
                      <p className="mt-1 text-[10px] text-slate-400">
                        {reaAnalysis.report.scriptsParsed}/{reaAnalysis.report.scriptsFound} scripts parsed · {reaAnalysis.report.semanticNodeCount} semantic nodes · {reaAnalysis.report.relationCount} relationships
                        {reaAnalysis.report.parseFailures > 0 ? ` · ${reaAnalysis.report.parseFailures} parse issue(s)` : ""}
                      </p>
                      <div className="mt-2 grid gap-2 text-[10px] sm:grid-cols-2">
                        <p><span className="font-bold text-slate-300">Functions:</span> <span className="text-slate-400">{reaAnalysis.report.functionNames.join(", ") || "No named functions identified."}</span></p>
                        <p><span className="font-bold text-slate-300">State names:</span> <span className="text-slate-400">{reaAnalysis.report.stateNames.slice(0, 16).join(", ") || "No bindings identified."}</span></p>
                        <p><span className="font-bold text-slate-300">Input events:</span> <span className="text-slate-400">{reaAnalysis.report.inputEvents.join(", ") || "No literal event names identified."}</span></p>
                        <p><span className="font-bold text-slate-300">Update APIs:</span> <span className="text-slate-400">{reaAnalysis.report.gameLoopApis.join(", ") || "No common update API identified."}</span></p>
                        <p><span className="font-bold text-slate-300">Progress stores:</span> <span className="text-slate-400">{reaAnalysis.report.progressStores.join(", ") || "No common browser storage API identified."}</span></p>
                      </div>
                      {reaAnalysis.report.limitations.length > 0 && (
                        <details className="mt-2 text-[9px] text-slate-500">
                          <summary className="cursor-pointer font-bold">REA coverage limits</summary>
                          <ul className="mt-1 list-disc space-y-1 pl-4">
                            {reaAnalysis.report.limitations.map((limitation, index) => <li key={`${index}:${limitation}`}>{limitation}</li>)}
                          </ul>
                        </details>
                      )}
                      <p className="mt-2 text-[9px] text-slate-500">These are static candidates, not proof that gameplay paths run. To use the findings, add them to your revision prompt and review the text before applying.</p>
                      <button
                        type="button"
                        onClick={addReaFindingsToPrompt}
                        disabled={!instruction.trim()}
                        className="mt-2 rounded-lg border border-violet-300/20 bg-violet-300/10 px-2.5 py-1.5 text-[10px] font-bold text-violet-100 hover:bg-violet-300/15 disabled:opacity-40"
                        data-testid="button-rea-add-to-prompt"
                      >
                        Add findings to revision prompt
                      </button>
                    </div>
                  )}
                </div>
              </section>
            )}
            <div className="grid gap-3 border-t border-white/10 p-4 lg:grid-cols-[1fr_1fr]">
              {selected.kind === "html" ? (
                <div className="space-y-2">
                  <label htmlFor="revision-instruction" className="text-xs font-extrabold text-slate-200">Revise this browser game</label>
                  <textarea id="revision-instruction" value={instruction} onChange={(event) => setInstruction(event.target.value)} placeholder="Describe one change to make…" rows={2} maxLength={1000} className="w-full resize-y rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-xs text-white placeholder:text-slate-500 focus:border-emerald-300/50 focus:outline-none" />
                   <p className="text-[10px] leading-relaxed text-slate-500">The selected model receives game code and your instruction; bundled media bytes are kept local. Use local-only mode for private source.</p>
                  <p className="text-[10px] leading-relaxed text-slate-500">A change is applied only when it returns complete HTML that passes Arcade's game safety checks.</p>
                   {compactHtml && compactHtml.source.length > 50_000 && <p className="text-[10px] text-amber-200">This game has more than 50 KB of executable source after media is excluded. It can still be played locally.</p>}
                  <div className="flex flex-wrap gap-2">
                    <button type="button" onClick={() => void revise()} disabled={workshopActive || busy || savingShelf > 0 || selected.revisionUndoSource !== undefined || !instruction.trim() || !compactHtml || compactHtml.source.length > 50_000} className="rounded-lg bg-emerald-400 px-3 py-2 text-xs font-black text-slate-950 hover:bg-emerald-300 disabled:cursor-not-allowed disabled:opacity-40">
                      {busy ? "Revising…" : "Apply revision"}
                    </button>
                    {busy && revisionAbortRef.current && (
                      <button
                        type="button"
                        data-testid="button-cancel-imported-revision"
                        onClick={() => revisionAbortRef.current?.abort()}
                        className="rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-xs font-bold text-red-200 hover:bg-red-500/20"
                      >
                        Stop revision
                      </button>
                    )}
                  </div>
                  {selected.revisionUndoSource !== undefined && (
                    <div className="rounded-lg border border-amber-300/20 bg-amber-300/[0.06] p-3" data-testid="imported-revision-undo">
                      <p className="text-[11px] font-bold text-amber-100">Review this revision in the game above.</p>
                      <p className="mt-1 text-[10px] leading-relaxed text-slate-400">Keep it to accept, or restore the earlier source. Your game identity and browser progress stay the same.</p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        <ImportedGameSourceComparison previous={selected.revisionUndoSource} current={selected.source} onBackToGame={() => {
                          htmlFrameRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
                          htmlFrameRef.current?.focus();
                        }} />
                        <button type="button" disabled={workshopActive || savingShelf > 0 || busy} onClick={() => void keepHtmlRevision()} className="rounded-lg border border-emerald-300/25 bg-emerald-300/10 px-3 py-2 text-[10px] font-bold text-emerald-100 hover:bg-emerald-300/15 disabled:opacity-40" data-testid="button-keep-imported-revision">
                          Keep revision
                        </button>
                        <button type="button" disabled={workshopActive || savingShelf > 0 || busy} onClick={() => void undoHtmlRevision()} className="rounded-lg border border-amber-300/25 bg-amber-300/10 px-3 py-2 text-[10px] font-bold text-amber-100 hover:bg-amber-300/15 disabled:opacity-40" data-testid="button-undo-imported-revision">
                          Undo revision
                        </button>
                      </div>
                    </div>
                  )}
                  {selected.revisionUndoSource === undefined && revisionCopies.length > 0 && (
                    <div className="rounded-xl border border-sky-300/20 bg-sky-300/5 p-3" data-testid="imported-revision-rollback">
                      <p className="text-[11px] font-bold text-sky-100">Previous versions ({revisionCopies.length})</p>
                      <p className="mt-1 break-words text-[10px] text-slate-300">Active source: {selected.revisionLabel ?? "Imported or earlier source"}</p>
                      <p className="mt-1 text-[10px] leading-relaxed text-slate-400">
                        {revisionCopies[0].label ?? "Earlier source"} · saved {new Date(revisionCopies[0].savedAt).toLocaleString()} · {revisionCopies[0].sizeKb} KB.
                        {" "}Restore replaces the active source; the replaced version remains recoverable. Your game identity and saved progress stay the same.
                      </p>
                      <button type="button" data-testid="button-restore-imported-revision" disabled={workshopActive || busy || savingShelf > 0} onClick={() => void restoreHtmlRevision()} className="mt-2 rounded-lg border border-sky-300/25 bg-sky-300/10 px-3 py-2 text-[10px] font-bold text-sky-100 hover:bg-sky-300/15 disabled:opacity-40">
                        Restore previous version
                      </button>
                      <div className="mt-2">
                        <ImportedGameSourceComparison previous={revisionCopies[0].source} current={selected.source} onBackToGame={() => {
                          htmlFrameRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
                          htmlFrameRef.current?.focus();
                        }} />
                      </div>
                      {revisionCopies.length > 1 && (
                        <details className="mt-3" data-testid="imported-revision-history">
                          <summary className="cursor-pointer text-[11px] font-bold text-sky-100">Older versions ({revisionCopies.length - 1})</summary>
                          <ol className="mt-2 space-y-2">
                            {revisionCopies.slice(1).map((copy, index) => (
                              <li key={`${copy.savedAt}-${index}`} className="rounded-lg border border-white/10 p-2" data-testid="imported-revision-history-entry">
                                <p className="break-words text-[11px] font-semibold text-slate-200">{copy.label ?? "Earlier source"}</p>
                                <p className="mt-1 text-[10px] text-slate-400">Saved {new Date(copy.savedAt).toLocaleString()} · {copy.sizeKb} KB</p>
                                <button type="button" disabled={workshopActive || busy || savingShelf > 0} onClick={() => void restoreHtmlRevision(index + 1)} className="mt-2 rounded-lg border border-sky-300/25 px-3 py-2 text-[10px] font-bold text-sky-100 hover:bg-sky-300/15 disabled:opacity-40">
                                  Restore this version
                                </button>
                              </li>
                            ))}
                          </ol>
                        </details>
                      )}
                      <p className="mt-3 text-[10px] leading-relaxed text-slate-400">
                        {revisionCopies.length} of up to {MAX_IMPORTED_REVISION_COPIES} previous versions retained locally · {MAX_IMPORTED_REVISION_BYTES / 1024 / 1024} MiB source limit per game. Oldest copies are removed when either limit is reached. Pending edits must be kept or undone first.
                      </p>
                    </div>
                  )}
                </div>
              ) : selected.kind === "nes" ? (
                <div className="space-y-2">
                  <div>
                    <p className="text-xs font-extrabold text-slate-200">Prompt-based browser remake</p>
                    <p className="mt-1 text-[10px] leading-relaxed text-slate-500">The prompt uses only this filename and your description. ROM bytes are never read for a remake.</p>
                  </div>
                  <textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Describe the broad mechanics or feeling to recreate in an original game…" rows={2} maxLength={800} className="w-full resize-y rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-xs text-white placeholder:text-slate-500 focus:border-cyan-300/50 focus:outline-none" />
                  <button type="button" onClick={() => onUseRemakePrompt(remakePrompt)} disabled={!remakePrompt} className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-300/20 bg-cyan-300/10 px-3 py-2 text-xs font-bold text-cyan-100 hover:bg-cyan-300/15 disabled:opacity-40">
                    <Copy size={13} /> Load prompt into game creator
                  </button>
                  {remakePrompt && <details className="text-[10px] text-slate-400"><summary className="cursor-pointer">View prompt</summary><p className="mt-2 rounded-lg bg-black/20 p-2 leading-relaxed">{remakePrompt}</p></details>}
                </div>
              ) : (
                <div className="space-y-2">
                  <p className="text-xs font-extrabold text-slate-200">Prompt modification needs editable source</p>
                  <p className="text-[10px] leading-relaxed text-slate-500">
                    This ROM can be played and saved, but it is not source code. For gameplay-changing prompts, import an authorized HTML/ZIP game source; Arcade sends that source to the selected model and applies only revisions that pass its safety checks.
                  </p>
                </div>
              )}
              <div className="rounded-lg border border-white/5 bg-white/[0.025] p-3">
                <p className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-wider text-slate-300"><FileCode2 size={13} /> What can change?</p>
                <p className="mt-1.5 text-[11px] leading-relaxed text-slate-500">
                  {selected.kind === "html"
                    ? "Revisions change the current HTML game source after success. Imports with external resources are declined."
                    : selected.kind === "nes"
                      ? "This NES ROM can be played, not edited as source. A remake prompt starts a separate original game."
                      : "This console ROM is playable and saveable. It cannot be prompt-modified without the game's editable source."}
                </p>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex min-h-56 flex-col items-center justify-center rounded-2xl border border-dashed border-white/10 bg-white/[0.02] px-6 text-center">
            {loaded ? <Gamepad2 size={24} className="text-slate-500" /> : <div className="h-6 w-6 animate-pulse rounded-full bg-white/10" />}
            <p className="mt-3 text-sm font-extrabold text-slate-200">{loaded ? "Your import shelf is clear." : "Opening your local shelf…"}</p>
            <p className="mt-1 max-w-sm text-xs leading-relaxed text-slate-500">{loaded ? "Import authorized HTML source, a homebrew NES or CHIP-8 program, or a supported multi-system ROM to begin." : "Checking this browser's saved imports."}</p>
          </div>
        )}
      </div>

      <aside className="min-w-0">
        <div className="glass rounded-2xl border border-white/10 p-4">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-black uppercase tracking-[0.16em] text-slate-200">Local shelf</h3>
            <span className="font-mono text-[10px] text-slate-500">{games.length}/12</span>
          </div>
          {unsavedIds.length > 0 && <div role="status" aria-label="Unsaved imported games" className="mt-3 rounded-lg border border-amber-300/25 bg-amber-300/10 p-3 text-xs text-amber-100">
            <p>{unsavedIds.length} {unsavedIds.length === 1 ? "game has" : "games have"} unsaved changes. Keep this tab open until saved.</p>
            <button type="button" onClick={() => void retryShelfSave()} disabled={savingShelf > 0 || busy || removing || refreshingShelf} className="mt-2 rounded border border-amber-300/30 px-3 py-2 font-bold disabled:opacity-50">
              {savingShelf ? "Saving…" : "Retry save"}
            </button>
          </div>}
          {externalShelfChange && <div role="status" aria-label="Shelf changed in another tab" className="mt-3 rounded-lg border border-cyan-300/25 bg-cyan-300/10 p-3 text-xs text-cyan-100">
            <p>The saved shelf changed or could not be refreshed. Unsaved work in this tab has not been replaced.</p>
            <button type="button" onClick={() => void reloadSavedShelf()} disabled={savingShelf > 0 || busy || removing || refreshingShelf} className="mt-2 rounded border border-cyan-300/30 px-3 py-2 font-bold disabled:opacity-50">
              {refreshingShelf ? "Refreshing…" : "Refresh saved shelf"}
            </button>
          </div>}
          <div className="mt-3 space-y-1.5">
            {games.map((game) => (
              <button key={game.id} data-testid={`button-select-imported-game-${game.id}`} type="button" onClick={() => { if (workshopLaunch && game.id !== workshopLaunch.gameId) onExitWorkshop?.(); setSelectedId(game.id); setError(""); setNotice(""); }} className={`w-full rounded-lg border px-3 py-2.5 text-left transition ${selectedId === game.id ? "border-emerald-300/30 bg-emerald-300/[0.08]" : "border-transparent bg-white/[0.025] hover:border-white/10 hover:bg-white/[0.05]"}`}>
                <span className="block truncate text-xs font-bold text-slate-200">{game.name}</span>
                {unsavedIds.includes(game.id) && <span className="block text-[10px] font-bold text-amber-200">Not saved · this tab only</span>}
                <span className="mt-1 block text-[9px] font-bold uppercase tracking-wider text-slate-500">
                  {game.kind === "html"
                    ? "Offline HTML"
                    : game.kind === "nes"
                      ? "NES homebrew"
                      : game.kind === "chip8"
                        ? chip8DialectLabel(game.chip8Dialect ?? "chip8")
                        : game.system ? arcadeEmulatorSystemLabel(game.system) : "Console ROM"}
                </span>
              </button>
            ))}
            {loaded && games.length === 0 && <p className="rounded-lg bg-black/15 px-3 py-4 text-[11px] leading-relaxed text-slate-500">Imported games appear here and remain on this device.</p>}
          </div>
          <div className="mt-4 border-t border-white/5 pt-3">
            <p className="text-[10px] font-extrabold text-slate-300">Safety & limits</p>
            <ul className="mt-2 space-y-1.5 text-[10px] leading-relaxed text-slate-500">
              <li>Browser games: HTML up to 6 MB, or ZIP up to 3 MB compressed / 6 MB unpacked. Offline assets are inlined.</li>
              <li>ZIP limitations: one HTML page; no external URLs, runtime fetch, or unbundled JavaScript modules.</li>
              <li>NES/NES 2.0: mapper IDs 0–5, 7, 9, 11, 34, 38, 66, 71, 79, 94, 118, 119, 140, 180, 240, 241; 1 MB maximum.</li>
              <li>NES save states and battery-backed saves stay on this browser; no external devices or netplay.</li>
              <li>NES ROMs are playable, not source-editable; prompt remakes create a new browser game.</li>
              <li>Classic CHIP-8: even-sized .ch8/.c8 programs, 2 bytes–3.5 KB. Existing 64×32 behavior and saves are preserved. CHIP-48, XO-CHIP, and other profiles are not selected automatically.</li>
              <li>Super-CHIP (modern): .sc8/.sch8, or .ch8/.c8 with the dialect selected above; 2 bytes–3.5 KB in 4 KB memory. Includes 128×64/64×32 modes, 16×16 sprites, scrolling, large hex font, eight per-game saved RPL flags, and normal exit. It uses clipped sprites, Vx shifts, unchanged I on register transfers, and key-release waits. Original HP48 half-pixel scrolling/collision quirks, cross-game RPL sharing, XO-CHIP, and sound output are not supported.</li>
              <li>CHIP-8 programs are playable, not source-editable; prompt remakes create a separate original browser game.</li>
              <li>EmulatorJS cores: GB/GBC, GBA, SNES, Mega Drive, Master System, Game Gear, and N64; ROMs up to 64 MB. First launch needs internet; saves default to browser storage and auto-save every minute.</li>
              <li>Disc images, BIOS files, DOS games, PSP, 3DS, arcade ROM sets, and other unlisted formats are not enabled. No copyrighted ROMs or BIOS files are bundled.</li>
              <li>EmulatorJS ROMs are play/save only. Prompt gameplay edits require an authorized, editable HTML/ZIP source import.</li>
              <li>Local storage may be cleared by your browser at any time.</li>
              <li>Do not import games you are not authorized to use.</li>
            </ul>
          </div>
        </div>
      </aside>
    </section>
  );
}
