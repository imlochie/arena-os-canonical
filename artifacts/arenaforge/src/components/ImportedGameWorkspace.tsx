"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Copy, FileCode2, Gamepad2, HardDrive, ShieldCheck, Trash2, Upload } from "lucide-react";
import { createGameSandboxDocument, useArcadeGameSave } from "../lib/arcadeGameSave";
import { loadImportedGames, saveImportedGameChanges, saveImportedGames } from "../lib/importedGameStorage";
import { deleteNesSaveState, readNesSaveState, writeNesSaveState } from "../lib/nesSaveStates";
import {
  arcadeEmulatorSystemLabel,
  ARCADE_EMULATOR_SYSTEMS,
  detectArcadeEmulatorSystem,
  isArcadeEmulatorSystemId,
  type ArcadeEmulatorSystemId,
} from "../lib/arcadeEmulatorRuntime";
import { importedHtmlSafetyIssue } from "@workspace/arena/lib/games";
import EmulatorJsPlayer from "./EmulatorJsPlayer";
import type { ButtonKey, NES } from "jsnes";

type ImportedGame = {
  id: string;
  name: string;
  kind: "html" | "nes" | "emulator";
  source: string;
  revisionUndoSource?: string;
  addedAt: number;
  system?: ArcadeEmulatorSystemId;
  romData?: ArrayBuffer;
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
};

const MAX_ARCHIVE_CONTENT_BYTES = 6 * 1024 * 1024;
const MAX_HTML_BYTES = MAX_ARCHIVE_CONTENT_BYTES;
const MAX_ROM_BYTES = 1024 * 1024;
const MAX_EMULATOR_ROM_BYTES = 64 * 1024 * 1024;
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

async function inlineArchiveCss(
  css: string,
  cssPath: string,
  files: Record<string, any>,
  seen = new Set<string>(),
): Promise<string> {
  if (seen.has(cssPath)) throw new Error("The project contains a circular stylesheet import.");
  const nextSeen = new Set(seen);
  nextSeen.add(cssPath);
  const imports = [...css.matchAll(/@import\s+(?:url\(\s*)?(['"])(.*?)\1\s*\)?[^;]*;/gi)];
  for (const match of imports) {
    const targetPath = archivePath(cssPath, match[2]);
    if (!targetPath) continue;
    const target = files[targetPath];
    if (!target) throw new Error(`The archive is missing stylesheet ${match[2]}.`);
    const nested = await target.async("string");
    const rewritten = await inlineArchiveCss(nested, targetPath, files, nextSeen);
    css = css.replace(match[0], rewritten);
  }
  const urls = [...css.matchAll(/url\(\s*(?:(['"])(.*?)\1|([^)'"\s][^)]*))\s*\)/gi)];
  for (const match of urls) {
    const reference = (match[2] ?? match[3] ?? "").trim();
    const targetPath = archivePath(cssPath, reference);
    if (!targetPath) continue;
    const target = files[targetPath];
    if (!target) throw new Error(`The archive is missing style asset ${reference}.`);
    const bytes = await target.async("uint8array");
    const dataUrl = `data:${mimeType(targetPath)};base64,${toBase64(bytes)}`;
    css = css.replace(match[0], `url("${dataUrl}")`);
  }
  return css;
}

async function inlineArchiveScriptMediaSources(
  source: string,
  htmlPath: string,
  files: Record<string, any>,
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
  const document = new DOMParser().parseFromString(source, "text/html");
  for (const script of Array.from(document.querySelectorAll("script[src]")) as HTMLScriptElement[]) {
    const reference = script.getAttribute("src") ?? "";
    const path = archivePath(entryPath, reference);
    if (!path) continue;
    const scriptFile = files[path];
    if (!scriptFile) throw new Error(`The archive is missing game script ${reference}.`);
    const scriptSource = await scriptFile.async("string");
    if (script.type === "module" && /\b(?:import|export)\s*(?:\(|[{*A-Za-z_$])/m.test(scriptSource)) {
      throw new Error("This project uses JavaScript modules. Bundle modules into a single offline script before importing.");
    }
    script.removeAttribute("src");
    script.removeAttribute("integrity");
    script.removeAttribute("crossorigin");
    script.textContent = scriptSource.replace(/<\/script/gi, "<\\/script");
  }
  for (const script of Array.from(document.querySelectorAll("script"))) {
    script.textContent = await inlineArchiveScriptMediaSources(script.textContent ?? "", entryPath, files);
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
      style.textContent = await inlineArchiveCss(await target.async("string"), path, files);
      link.replaceWith(style);
    } else {
      const bytes = await target.async("uint8array");
      link.setAttribute("href", `data:${mimeType(path)};base64,${toBase64(bytes)}`);
    }
  }

  for (const style of Array.from(document.querySelectorAll("style"))) {
    style.textContent = await inlineArchiveCss(style.textContent ?? "", entryPath, files);
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
      element.setAttribute(attribute, `data:${mimeType(path)};base64,${toBase64(bytes)}`);
    }
  }
  for (const element of Array.from(document.querySelectorAll("[style]"))) {
    element.setAttribute("style", await inlineArchiveCss(element.getAttribute("style") ?? "", entryPath, files));
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
      rewritten.push(`data:${mimeType(path)};base64,${toBase64(bytes)}${descriptor.length ? ` ${descriptor.join(" ")}` : ""}`);
    }
    element.setAttribute("srcset", rewritten.join(", "));
  }

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
    return htmlSafetyIssue(game.source) === null &&
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
  return false;
}

export default function ImportedGameWorkspace({ onReviseSource, onUseRemakePrompt }: ImportedGameWorkspaceProps) {
  const [games, setGames] = useState<ImportedGame[]>([]);
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
  const [nesSaveAvailable, setNesSaveAvailable] = useState(false);
  const [nesSaveMessage, setNesSaveMessage] = useState("");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const htmlFrameRef = useRef<HTMLIFrameElement>(null);
  const nesRef = useRef<NES | null>(null);
  const revisionAbortRef = useRef<AbortController | null>(null);
  const buttonsRef = useRef<Map<string, ButtonKey>>(new Map());
  const selected = games.find((game) => game.id === selectedId) ?? null;
  const selectedEmulatorRom = useMemo(
    () => selected?.kind === "emulator" && selected.romData instanceof ArrayBuffer ? selected.romData : null,
    [selected],
  );
  const compactHtml = useMemo(
    () => selected?.kind === "html" ? maskEmbeddedAssets(selected.source) : null,
    [selected?.id, selected?.source],
  );
  const gameSaves = useArcadeGameSave(
    htmlFrameRef,
    selected?.kind === "html" ? selected.id : null,
  );

  useEffect(() => () => revisionAbortRef.current?.abort(), []);

  useEffect(() => {
    if (!selected || selected.kind !== "nes") {
      setNesSaveAvailable(false);
      setNesSaveMessage("");
      return;
    }
    let active = true;
    readNesSaveState(selected.id).then((state) => {
      if (active) setNesSaveAvailable(state !== null);
    }).catch(() => {
      if (active) setNesSaveMessage("Local save-state storage is unavailable in this browser.");
    });
    return () => { active = false; };
  }, [selected?.id, selected?.kind]);

  const saveNesProgress = async () => {
    if (!selected || selected.kind !== "nes" || !nesRef.current) return;
    try {
      await writeNesSaveState(selected.id, nesRef.current.toJSON());
      setNesSaveAvailable(true);
      setNesSaveMessage("Progress saved on this browser.");
    } catch (cause) {
      setNesSaveMessage(errorMessage(cause));
    }
  };

  const loadNesProgress = async () => {
    if (!selected || selected.kind !== "nes" || !nesRef.current) return;
    try {
      const state = await readNesSaveState(selected.id);
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
      await deleteNesSaveState(selected.id);
      setNesSaveAvailable(false);
      setNesSaveMessage("Saved progress cleared from this browser.");
    } catch (cause) {
      setNesSaveMessage(errorMessage(cause));
    }
  };

  useEffect(() => {
    let active = true;
    const loadShelf = async () => {
      try {
        const stored = await loadImportedGames();
        const valid = stored.filter(isStoredImportedGame).sort((a, b) => b.addedAt - a.addedAt).slice(0, 12);
        if (active) {
          setGames(valid);
          setSelectedId(valid[0]?.id ?? "");
        }
      } catch {
        if (active) setError("Your local game shelf could not be read. New imports can still be played in this session.");
      } finally {
        if (active) setLoaded(true);
      }
    };
    void loadShelf();
    return () => { active = false; };
  }, []);

  const saveGames = useCallback(async (next: ImportedGame[]) => {
    setGames(next);
    try {
      await saveImportedGameChanges(games, next);
      return true;
    } catch {
      setError("The game is available for this session, but this browser could not save the local shelf.");
      return false;
    }
  }, [games]);

  useEffect(() => {
    if (!selected || selected.kind !== "nes" || !canvasRef.current) {
      nesRef.current = null;
      return;
    }
    let active = true;
    let animation = 0;
    let batteryFlush = 0;
    let flushBatteryRam = () => {};
    const start = async () => {
      try {
        const { NES } = await import("jsnes");
        if (!active) return;
        const canvas = canvasRef.current;
        if (!canvas) return;
        const context = canvas.getContext("2d", { alpha: false });
        if (!context) throw new Error("Canvas rendering is unavailable in this browser.");
        const pixels = context.createImageData(256, 240);
        const packedPixels = new Uint32Array(pixels.data.buffer);
        const batteryRam = new Uint8Array(0x2000);
        const batteryKey = `arenaforge.nes-sram.v1:${selected.id}`;
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
        const nes = new NES({
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
        });
        nes.loadROM(atob(selected.source));
        const cpuMemory = (nes as unknown as { cpu?: { mem?: Uint8Array } }).cpu?.mem;
        if (cpuMemory) cpuMemory.set(batteryRam, 0x6000);
        try {
          const savedState = await readNesSaveState(selected.id);
          if (active && savedState) {
            nes.fromJSON(savedState as any);
            setNesSaveAvailable(true);
          }
        } catch {
          if (active) setNesSaveMessage("This browser could not restore the local save state.");
        }
        if (!active) return;
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
        setError("");
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
      nesRef.current = null;
      buttonsRef.current.clear();
    };
  }, [selected]);

  const handleImport = async (file: File | undefined, kind: "html" | "nes" | "emulator") => {
    if (!file) return;
    setError("");
    setNotice("");
    if (!rightsAccepted) {
      setError("Accept the rights statement before importing a game.");
      return;
    }
    try {
      if (games.length >= 12) throw new Error("Your local shelf is full. Remove a game before importing another.");
      if (kind === "html") {
        const isArchive = file.name.toLowerCase().endsWith(".zip") || file.type === "application/zip";
        if (isArchive && file.size > MAX_ARCHIVE_BYTES) throw new Error("Game archives are limited to 3 MB compressed.");
        if (!isArchive && file.size > MAX_HTML_BYTES) throw new Error("HTML files are limited to 6 MB.");
        const source = isArchive ? await bundleOfflineBrowserGame(file) : await file.text();
        const issue = htmlSafetyIssue(source);
        if (issue) throw new Error(issue);
        const game: ImportedGame = { id: crypto.randomUUID(), name: file.name, kind, source, addedAt: Date.now() };
        const next = [game, ...games].slice(0, 12);
        await saveGames(next);
        setSelectedId(game.id);
        setNotice("Imported locally. The game stays in this browser only.");
        return;
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
        await saveGames([game, ...games].slice(0, 12));
        setSelectedId(game.id);
        setNotice(`${arcadeEmulatorSystemLabel(system)} game imported to this browser's local shelf.`);
        return;
      }
      if (file.size < 16 || file.size > MAX_ROM_BYTES) throw new Error("NES ROMs must be between 16 bytes and 1 MB.");
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (bytes[0] !== 0x4e || bytes[1] !== 0x45 || bytes[2] !== 0x53 || bytes[3] !== 0x1a) {
        throw new Error("This does not look like an iNES-format homebrew ROM.");
      }
      const source = toBase64(bytes);
      const game: ImportedGame = { id: crypto.randomUUID(), name: file.name, kind, source, addedAt: Date.now() };
      await saveGames([game, ...games].slice(0, 12));
      setSelectedId(game.id);
      setNotice("ROM imported to this browser's local shelf.");
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  const applyHtmlRevision = async (id: string, source: string) => {
    const current = games.find((game) => game.id === id);
    if (!current || current.kind !== "html" || current.revisionUndoSource !== undefined) return false;
    const next = games.map((game) => game.id === id
      ? { ...game, source, revisionUndoSource: game.source }
      : game);
    const saved = await saveGames(next);
    gameSaves.reloadGame();
    setReaAnalysis((current) => current?.gameId === id ? null : current);
    return saved;
  };

  const keepHtmlRevision = async () => {
    if (!selected || selected.kind !== "html" || selected.revisionUndoSource === undefined) return;
    const next = games.map((game) => {
      if (game.id !== selected.id || game.kind !== "html" || game.revisionUndoSource === undefined) return game;
      const { revisionUndoSource: _revisionUndoSource, ...accepted } = game;
      return accepted;
    });
    await saveGames(next);
    setNotice("Revision kept. Your saved progress is unchanged.");
  };

  const undoHtmlRevision = async () => {
    if (!selected || selected.kind !== "html" || selected.revisionUndoSource === undefined) return;
    const next = games.map((game) => {
      if (game.id !== selected.id || game.kind !== "html" || game.revisionUndoSource === undefined) return game;
      const { revisionUndoSource, ...restored } = game;
      return { ...restored, source: revisionUndoSource };
    });
    await saveGames(next);
    gameSaves.reloadGame();
    setReaAnalysis((current) => current?.gameId === selected.id ? null : current);
    setNotice("Earlier game source restored. Your saved progress is unchanged.");
  };

  const revise = async () => {
    if (!selected || selected.kind !== "html" || !instruction.trim() || busy) return;
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
      await applyHtmlRevision(selected.id, revised);
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
    if (!selected) return;
    const next = games.filter((game) => game.id !== selected.id);
    await saveGames(next);
    setReaAnalysis((current) => current?.gameId === selected.id ? null : current);
    setSelectedId(next[0]?.id ?? "");
    setNotice("");
    setError("");
  };

  const remakePrompt = useMemo(() => {
    if (!selected || selected.kind !== "nes" || !description.trim()) return "";
    return `Create a new, original browser game inspired only by this user description. The reference filename is ${selected.name}. Do not reproduce copyrighted names, characters, music, levels, graphics, or code. User description: ${description.trim()}`;
  }, [description, selected]);

  const setNesButton = (key: string, button: ButtonKey, pressed: boolean) => {
    const nes = nesRef.current;
    if (!nes) return;
    if (pressed) {
      if (buttonsRef.current.get(key) === button) return;
      buttonsRef.current.set(key, button);
      nes.buttonDown(1, button);
    } else {
      buttonsRef.current.delete(key);
      nes.buttonUp(1, button);
    }
  };

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
      setNesButton(`key:${event.key}`, button, true);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      const button = keyMap[event.key] ?? keyMap[event.key.toLowerCase()];
      if (button !== undefined) setNesButton(`key:${event.key}`, button, false);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [selected]);

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
                Homebrew NES, supported multi-system ROMs, and authorized HTML5 games. Imported game files stay in this browser. HTML runs in a restricted sandbox; multi-system cores download once from EmulatorJS and are cached locally.
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

          <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
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
        {notice && <div role="status" className="rounded-xl border border-emerald-400/20 bg-emerald-400/10 px-3 py-2.5 text-xs text-emerald-100">{notice}</div>}

        {selected ? (
          <div className="glass overflow-hidden rounded-2xl border border-white/10">
            <div className="flex flex-wrap items-center gap-2 border-b border-white/10 px-4 py-3">
              <span className={`rounded-full px-2 py-1 text-[9px] font-black uppercase tracking-wider ${selected.kind === "html" ? "bg-emerald-300/10 text-emerald-200" : "bg-cyan-300/10 text-cyan-200"}`}>
                {selected.kind === "html"
                  ? "Browser game"
                  : selected.kind === "nes"
                    ? "NES homebrew"
                    : selected.system ? arcadeEmulatorSystemLabel(selected.system) : "Console ROM"}
              </span>
              <h3 className="min-w-0 flex-1 truncate text-sm font-extrabold text-white">{selected.name}</h3>
              <button type="button" onClick={removeSelected} className="inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-[11px] font-bold text-slate-400 hover:bg-red-400/10 hover:text-red-200" aria-label={`Remove ${selected.name}`}>
                <Trash2 size={13} /> Remove
              </button>
            </div>
            {selected.kind === "html" ? (
              <div className="bg-black/30 p-2 sm:p-3">
                <iframe
                  key={`${selected.id}:${selected.source.length}:${gameSaves.reloadKey}`}
                  title={`Playable game: ${selected.name}`}
                  sandbox="allow-scripts"
                  referrerPolicy="no-referrer"
                  ref={htmlFrameRef}
                  srcDoc={createGameSandboxDocument(selected.source, selected.id)}
                  className="h-[min(68vh,620px)] min-h-[320px] w-full rounded-lg border border-white/10 bg-black"
                />
                <div className="flex items-center justify-between gap-3 px-1 pt-2">
                  <p className="text-[10px] text-slate-500">
                    Progress saves in this browser{gameSaves.hasSavedProgress ? " · save data found" : ""}.
                  </p>
                  {gameSaves.hasSavedProgress && (
                    <button type="button" onClick={gameSaves.clearSavedProgress} className="text-[10px] font-bold text-slate-400 hover:text-red-200">
                      Clear progress
                    </button>
                  )}
                </div>
              </div>
            ) : selected.kind === "emulator" && selected.system && selectedEmulatorRom ? (
              <EmulatorJsPlayer
                gameId={selected.id}
                name={selected.name}
                rom={selectedEmulatorRom}
                system={selected.system}
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
                      onPointerDown={(event) => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); setNesButton(`touch:${label}`, button, true); }}
                      onPointerUp={() => setNesButton(`touch:${label}`, button, false)}
                      onPointerCancel={() => setNesButton(`touch:${label}`, button, false)}
                      onLostPointerCapture={() => setNesButton(`touch:${label}`, button, false)}
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
                    <button type="button" onClick={() => void revise()} disabled={busy || selected.revisionUndoSource !== undefined || !instruction.trim() || !compactHtml || compactHtml.source.length > 50_000} className="rounded-lg bg-emerald-400 px-3 py-2 text-xs font-black text-slate-950 hover:bg-emerald-300 disabled:cursor-not-allowed disabled:opacity-40">
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
                        <button type="button" onClick={() => void keepHtmlRevision()} className="rounded-lg border border-emerald-300/25 bg-emerald-300/10 px-3 py-2 text-[10px] font-bold text-emerald-100 hover:bg-emerald-300/15" data-testid="button-keep-imported-revision">
                          Keep revision
                        </button>
                        <button type="button" onClick={() => void undoHtmlRevision()} className="rounded-lg border border-amber-300/25 bg-amber-300/10 px-3 py-2 text-[10px] font-bold text-amber-100 hover:bg-amber-300/15" data-testid="button-undo-imported-revision">
                          Undo revision
                        </button>
                      </div>
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
            <p className="mt-1 max-w-sm text-xs leading-relaxed text-slate-500">{loaded ? "Import authorized HTML source, a homebrew NES ROM, or a supported multi-system ROM to begin." : "Checking this browser's saved imports."}</p>
          </div>
        )}
      </div>

      <aside className="min-w-0">
        <div className="glass rounded-2xl border border-white/10 p-4">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-black uppercase tracking-[0.16em] text-slate-200">Local shelf</h3>
            <span className="font-mono text-[10px] text-slate-500">{games.length}/12</span>
          </div>
          <div className="mt-3 space-y-1.5">
            {games.map((game) => (
              <button key={game.id} type="button" onClick={() => { setSelectedId(game.id); setError(""); setNotice(""); }} className={`w-full rounded-lg border px-3 py-2.5 text-left transition ${selectedId === game.id ? "border-emerald-300/30 bg-emerald-300/[0.08]" : "border-transparent bg-white/[0.025] hover:border-white/10 hover:bg-white/[0.05]"}`}>
                <span className="block truncate text-xs font-bold text-slate-200">{game.name}</span>
                <span className="mt-1 block text-[9px] font-bold uppercase tracking-wider text-slate-500">
                  {game.kind === "html"
                    ? "Offline HTML"
                    : game.kind === "nes"
                      ? "NES homebrew"
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
