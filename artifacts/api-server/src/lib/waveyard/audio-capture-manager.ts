import { randomUUID } from "node:crypto";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, statfs, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { promisify } from "node:util";

import { Rf64Recorder, recoverRf64Partial } from "@workspace/arena/lib/waveyard/capture/rf64";
import type { Rf64Format, Rf64RecordingResult } from "@workspace/arena/lib/waveyard/capture/rf64";

const execFileAsync = promisify(execFile);
const sessions = new Map<string, CaptureSession>();
const START_TIMEOUT_MS = 20_000;
const STOP_TIMEOUT_MS = 15_000;
const SHUTDOWN_STOP_TIMEOUT_MS = 5_000;
const SHUTDOWN_PIPE_SETTLE_TIMEOUT_MS = 2_000;
const CAPTURE_DISK_RESERVE_BYTES = 1024 * 1024 * 1024;
const CAPTURE_DISK_CHECK_INTERVAL_MS = 5_000;
const MAX_DEVICE_OUTPUT_BYTES = 1_000_000;

export interface AudioCaptureDevice {
  id: string;
  name: string;
  isDefault: boolean;
}

export interface AudioCaptureFormat {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  blockAlign: number;
}

export interface AudioCaptureStorageBudget {
  availableBytes: number;
  reserveBytes: number;
  canRecord: boolean;
  reason?: string;
}

export type AudioCaptureState = "starting" | "recording" | "stopping" | "completed" | "failed";

export interface AudioCaptureSnapshot {
  sessionId: string;
  status: AudioCaptureState;
  title: string;
  startedAt?: string;
  elapsedSeconds: number;
  discontinuityCount: number;
  availableBytes?: number;
  reserveBytes?: number;
  estimatedSecondsRemaining?: number;
  format?: AudioCaptureFormat;
  message?: string;
}

export interface AudioCaptureStartInput {
  title: string;
  artist?: string;
  album?: string;
  deviceId?: string;
}

export interface AudioCaptureFinalized {
  path: string;
  result: Rf64RecordingResult;
  format: AudioCaptureFormat;
  discontinuityCount: number;
  metadata: AudioCaptureStartInput;
  sessionDirectory: string;
}

export interface AudioCaptureRecovery {
  sessionId: string;
  title: string;
  artist?: string;
  album?: string;
  createdAt: string;
}

export interface AudioCaptureRecoveryFile extends AudioCaptureRecovery {
  path: string;
  sessionDirectory: string;
}

export interface AudioCaptureShutdownResult {
  stopped: number;
  preserved: number;
  forced: number;
  unresponsive: number;
}

interface PersistedCaptureManifest {
  sessionId: string;
  ownerId: string;
  metadata: AudioCaptureStartInput;
  createdAt: string;
  recordingFile?: string;
}

interface NativeEvent {
  type: string;
  message?: string;
  mode?: string;
  deviceId?: string;
  deviceName?: string;
  formatChunkBase64?: string;
  sampleRate?: number;
  channels?: number;
  bitsPerSample?: number;
  blockAlign?: number;
  devicePosition?: number;
  qpcPosition?: number;
  timestampError?: boolean;
  sampleFrames?: number;
}

interface CaptureSession {
  id: string;
  ownerId: string;
  metadata: AudioCaptureStartInput;
  status: AudioCaptureState;
  sessionDirectory: string;
  partialPath: string;
  finalPath: string;
  child: ChildProcessWithoutNullStreams;
  recorder?: Rf64Recorder;
  format?: AudioCaptureFormat;
  startedAt?: string;
  endedAt?: string;
  discontinuityCount: number;
  availableBytes?: number;
  reserveBytes?: number;
  estimatedSecondsRemaining?: number;
  failure?: string;
  notice?: string;
  final?: AudioCaptureFinalized;
  nativeStopped: boolean;
  stopSent: boolean;
  stderrDecoder: StringDecoder;
  stderrBuffer: string;
  eventChain: Promise<void>;
  pcmChain: Promise<void>;
  startedPromise: Promise<void>;
  resolveStarted: () => void;
  rejectStarted: (error: Error) => void;
  closePromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  resolveClose: (result: { code: number | null; signal: NodeJS.Signals | null }) => void;
  stopPromise?: Promise<AudioCaptureFinalized | null>;
  diskMonitor?: NodeJS.Timeout;
  diskMonitorBusy?: boolean;
  importedResponse?: unknown;
}

function captureHostPath(): string | null {
  if (process.platform !== "win32" || process.env.ARENA_DESKTOP_MODE !== "1") return null;
  const resources = process.env.ARENA_RESOURCES_DIR;
  if (!resources) return null;
  const host = join(resources, "native", "waveyard-capture-host.exe");
  return existsSync(host) ? host : null;
}

function captureRoot(): string {
  const dataRoot = process.env.ARENA_DATA_DIR;
  if (!dataRoot) throw new Error("The Windows desktop data directory is not configured.");
  return join(dataRoot, "waveyard", "capture");
}

async function readCaptureStorageBudget(): Promise<AudioCaptureStorageBudget> {
  const dataRoot = process.env.ARENA_DATA_DIR;
  if (!dataRoot) throw new Error("The Windows desktop data directory is not configured.");
  const filesystem = await statfs(dataRoot, { bigint: true });
  const available = filesystem.bavail * filesystem.bsize;
  const rawAvailableBytes = Number(
    available > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : available,
  );
  return createCaptureStorageBudget(rawAvailableBytes);
}

export function createCaptureStorageBudget(availableBytes: number): AudioCaptureStorageBudget {
  const safeAvailableBytes = Number.isFinite(availableBytes)
    ? Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(availableBytes)))
    : 0;
  const canRecord = safeAvailableBytes > CAPTURE_DISK_RESERVE_BYTES;
  return {
    availableBytes: safeAvailableBytes,
    reserveBytes: CAPTURE_DISK_RESERVE_BYTES,
    canRecord,
    ...(!canRecord
      ? { reason: "Free at least 1 GiB on Arena’s data drive before recording." }
      : {}),
  };
}

export function estimateCaptureSecondsRemaining(
  availableBytes: number,
  reserveBytes: number,
  format: AudioCaptureFormat,
): number {
  const bytesPerSecond = format.sampleRate * format.blockAlign;
  if (!Number.isSafeInteger(bytesPerSecond) || bytesPerSecond <= 0) return 0;
  return Math.max(0, Math.floor((availableBytes - reserveBytes) / bytesPerSecond));
}

export async function getAudioCaptureOptions(ownerId?: string): Promise<{
  available: boolean;
  devices: AudioCaptureDevice[];
  reason?: string;
  storage?: AudioCaptureStorageBudget;
  activeSession?: AudioCaptureSnapshot;
  recoveries?: AudioCaptureRecovery[];
  recoveryError?: string;
}> {
  const active = ownerId
    ? [...sessions.values()].find((session) =>
      session.ownerId === ownerId &&
      ["starting", "recording", "stopping", "failed"].includes(session.status))
    : undefined;
  const activeSession = active ? snapshot(active) : undefined;
  let recoveries: AudioCaptureRecovery[] | undefined;
  let recoveryError: string | undefined;
  if (ownerId && process.env.ARENA_DATA_DIR) {
    try {
      recoveries = await listRecoverableAudioCaptures(ownerId);
    } catch (error) {
      recoveryError = error instanceof Error ? error.message : "An interrupted recording could not be checked.";
    }
  }
  const host = captureHostPath();
  if (!host) {
    return {
      available: false,
      devices: [],
      reason: "Live system-audio capture is available only in the packaged Windows desktop app.",
      ...(activeSession ? { activeSession } : {}),
      ...(recoveries?.length ? { recoveries } : {}),
      ...(recoveryError ? { recoveryError } : {}),
    };
  }
  let storage: AudioCaptureStorageBudget;
  try {
    storage = await readCaptureStorageBudget();
  } catch {
    return {
      available: false,
      devices: [],
      reason: "Free disk space could not be checked; recording is disabled to protect your files.",
      ...(activeSession ? { activeSession } : {}),
      ...(recoveries?.length ? { recoveries } : {}),
      ...(recoveryError ? { recoveryError } : {}),
    };
  }
  if (!storage.canRecord) {
    return {
      available: false,
      devices: [],
      reason: storage.reason,
      storage,
      ...(activeSession ? { activeSession } : {}),
      ...(recoveries?.length ? { recoveries } : {}),
      ...(recoveryError ? { recoveryError } : {}),
    };
  }
  try {
    const { stdout } = await execFileAsync(host, ["devices"], {
      timeout: 10_000,
      maxBuffer: MAX_DEVICE_OUTPUT_BYTES,
      windowsHide: true,
    });
    const value = JSON.parse(stdout) as { devices?: unknown };
    if (!Array.isArray(value.devices) || value.devices.length > 128) {
      throw new Error("The Windows capture host returned an invalid playback-device list.");
    }
    const devices = value.devices.map((device) => {
      if (
        typeof device !== "object" || device === null ||
        typeof (device as AudioCaptureDevice).id !== "string" ||
        typeof (device as AudioCaptureDevice).name !== "string" ||
        typeof (device as AudioCaptureDevice).isDefault !== "boolean"
      ) {
        throw new Error("The Windows capture host returned an invalid playback device.");
      }
      return device as AudioCaptureDevice;
    });
    return {
      available: devices.length > 0 && storage.canRecord,
      devices,
      ...(devices.length === 0 ? { reason: "Windows has no active playback endpoint to capture." } : {}),
      storage,
      ...(activeSession ? { activeSession } : {}),
      ...(recoveries?.length ? { recoveries } : {}),
      ...(recoveryError ? { recoveryError } : {}),
    };
  } catch (error) {
    return {
      available: false,
      devices: [],
      reason: error instanceof Error ? error.message : "The Windows capture host could not enumerate playback devices.",
      storage,
      ...(activeSession ? { activeSession } : {}),
      ...(recoveries?.length ? { recoveries } : {}),
      ...(recoveryError ? { recoveryError } : {}),
    };
  }
}

function snapshot(session: CaptureSession): AudioCaptureSnapshot {
  const start = session.startedAt ? Date.parse(session.startedAt) : Date.now();
  const end = session.endedAt ? Date.parse(session.endedAt) : Date.now();
  return {
    sessionId: session.id,
    status: session.status,
    title: session.metadata.title,
    ...(session.startedAt ? { startedAt: session.startedAt } : {}),
    elapsedSeconds: Math.max(0, (end - start) / 1000),
    discontinuityCount: session.discontinuityCount,
    ...(session.availableBytes !== undefined ? { availableBytes: session.availableBytes } : {}),
    ...(session.reserveBytes !== undefined ? { reserveBytes: session.reserveBytes } : {}),
    ...(session.estimatedSecondsRemaining !== undefined
      ? { estimatedSecondsRemaining: session.estimatedSecondsRemaining }
      : {}),
    ...(session.format ? { format: session.format } : {}),
    ...(session.failure || session.notice ? { message: session.failure ?? session.notice } : {}),
  };
}

function sendStop(session: CaptureSession): void {
  if (session.stopSent || session.child.killed || session.child.exitCode !== null) return;
  session.stopSent = true;
  if (session.diskMonitor) {
    clearInterval(session.diskMonitor);
    session.diskMonitor = undefined;
  }
  if (session.status !== "failed") session.status = "stopping";
  session.child.stdin.write("stop\n", (error) => {
    if (error && !session.failure) session.failure = "Could not send the stop command to the Windows capture host.";
  });
}

function failSession(session: CaptureSession, error: unknown): void {
  if (!session.failure) session.failure = error instanceof Error ? error.message : String(error);
  session.status = "failed";
  session.rejectStarted(new Error(session.failure));
  sendStop(session);
}

async function handleNativeEvent(session: CaptureSession, event: NativeEvent): Promise<void> {
  if (event.type === "ready") {
    if (session.recorder) throw new Error("Capture host sent more than one ready event.");
    if (
      event.mode !== "system-loopback" ||
      typeof event.formatChunkBase64 !== "string" ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(event.formatChunkBase64)
    ) {
      throw new Error("Capture host returned an invalid audio-format handshake.");
    }
    const formatChunk = Buffer.from(event.formatChunkBase64, "base64");
    if (formatChunk.length < 16 || formatChunk.length > 4096) {
      throw new Error("Capture host returned an unsupported audio format.");
    }
    const format: Rf64Format = { formatChunk };
    const partialPath = session.partialPath;
    const finalPath = session.finalPath;
    session.recorder = await Rf64Recorder.create({ partialPath, finalPath, format });
    session.format = {
      sampleRate: session.recorder.format.sampleRate,
      channels: session.recorder.format.channels,
      bitsPerSample: session.recorder.format.bitsPerSample,
      blockAlign: session.recorder.format.blockAlign,
    };
    if (session.availableBytes !== undefined && session.reserveBytes !== undefined) {
      session.estimatedSecondsRemaining = estimateCaptureSecondsRemaining(
        session.availableBytes,
        session.reserveBytes,
        session.format,
      );
    }
    if (
      event.sampleRate !== session.format.sampleRate ||
      event.channels !== session.format.channels ||
      event.bitsPerSample !== session.format.bitsPerSample ||
      event.blockAlign !== session.format.blockAlign
    ) {
      await session.recorder.leaveRecoverable();
      throw new Error("Capture host format details did not match its PCM format chunk.");
    }
    session.child.stdin.write("start\n", (error) => {
      if (error) failSession(session, new Error("Could not start the Windows capture host."));
    });
    return;
  }
  if (event.type === "started") {
    if (!session.recorder) throw new Error("Capture host started before its audio format was validated.");
    if (session.status === "failed" || session.stopSent) return;
    session.status = "recording";
    session.startedAt = new Date().toISOString();
    session.resolveStarted();
    session.diskMonitor = setInterval(() => {
      if (session.diskMonitorBusy || session.status !== "recording") return;
      session.diskMonitorBusy = true;
      void readCaptureStorageBudget().then((budget) => {
        session.availableBytes = budget.availableBytes;
        session.reserveBytes = budget.reserveBytes;
        if (session.format) {
          session.estimatedSecondsRemaining = estimateCaptureSecondsRemaining(
            budget.availableBytes,
            budget.reserveBytes,
            session.format,
          );
        }
        if (!budget.canRecord && session.status === "recording") {
          session.notice = "Stopped before the data drive’s 1 GiB safety reserve was used; the recording is preserved below.";
          void stopAudioCapture(session.ownerId, session.id).catch((error: unknown) => {
            session.failure = error instanceof Error ? error.message : session.failure;
            session.status = "failed";
          });
        }
      }).catch(() => {
        if (session.status === "recording") {
          session.notice = "Free disk space could not be checked; Waveyard stopped and preserved the recording.";
          void stopAudioCapture(session.ownerId, session.id).catch((error: unknown) => {
            session.failure = error instanceof Error ? error.message : session.failure;
            session.status = "failed";
          });
        }
      }).finally(() => {
        session.diskMonitorBusy = false;
      });
    }, CAPTURE_DISK_CHECK_INTERVAL_MS);
    session.diskMonitor.unref();
    return;
  }
  if (event.type === "discontinuity") {
    session.discontinuityCount += 1;
    return;
  }
  if (event.type === "stopped") {
    session.nativeStopped = true;
    return;
  }
  if (event.type === "cancelled") {
    session.nativeStopped = true;
    return;
  }
  if (event.type === "warning") return;
  if (event.type === "error") {
    throw new Error(event.message || "Windows audio capture failed.");
  }
  throw new Error(`Windows capture host sent an unknown protocol event: ${event.type}`);
}

function queueNativeEvents(session: CaptureSession, chunk: Buffer): void {
  session.stderrBuffer += session.stderrDecoder.write(chunk);
  const lines = session.stderrBuffer.split(/\r?\n/);
  session.stderrBuffer = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    session.eventChain = session.eventChain.then(async () => {
      const event = JSON.parse(line) as NativeEvent;
      await handleNativeEvent(session, event);
    }).catch((error) => failSession(session, error));
  }
}

function makeSession(input: {
  id: string;
  ownerId: string;
  metadata: AudioCaptureStartInput;
  sessionDirectory: string;
  child: ChildProcessWithoutNullStreams;
  storageBudget: AudioCaptureStorageBudget;
}): CaptureSession {
  let resolveStarted!: () => void;
  let rejectStarted!: (error: Error) => void;
  const startedPromise = new Promise<void>((resolve, reject) => {
    resolveStarted = resolve;
    rejectStarted = reject;
  });
  let resolveClose!: (result: { code: number | null; signal: NodeJS.Signals | null }) => void;
  const closePromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    resolveClose = resolve;
  });
  return {
    ...input,
    status: "starting",
    partialPath: join(input.sessionDirectory, "recording.partial.wav"),
    finalPath: join(input.sessionDirectory, "recording.wav"),
    discontinuityCount: 0,
    availableBytes: input.storageBudget.availableBytes,
    reserveBytes: input.storageBudget.reserveBytes,
    nativeStopped: false,
    stopSent: false,
    stderrDecoder: new StringDecoder("utf8"),
    stderrBuffer: "",
    eventChain: Promise.resolve(),
    pcmChain: Promise.resolve(),
    startedPromise,
    resolveStarted,
    rejectStarted,
    closePromise,
    resolveClose,
  };
}

export async function startAudioCapture(
  ownerId: string,
  input: AudioCaptureStartInput,
): Promise<AudioCaptureSnapshot> {
  const host = captureHostPath();
  if (!host) throw new Error("Live audio capture is not available in this runtime.");
  if (Array.from(sessions.values()).some((session) => session.status === "starting" || session.status === "recording" || session.status === "stopping")) {
    throw new Error("A Waveyard recording is already in progress. Stop it before starting another.");
  }
  if (input.deviceId !== undefined && (input.deviceId.length === 0 || input.deviceId.length > 4096 || input.deviceId.includes("\0"))) {
    throw new Error("The selected playback endpoint is invalid.");
  }

  const id = randomUUID();
  const storageBudget = await readCaptureStorageBudget();
  if (!storageBudget.canRecord) throw new Error(storageBudget.reason || "Not enough free disk space to record safely.");
  const sessionDirectory = join(captureRoot(), id);
  await mkdir(sessionDirectory, { recursive: true });
  const createdAt = new Date().toISOString();
  const manifest: PersistedCaptureManifest = {
    sessionId: id,
    ownerId,
    metadata: input,
    createdAt,
  };
  await writeFile(join(sessionDirectory, "session.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  const args = ["record", ...(input.deviceId ? ["--device-id", input.deviceId] : [])];
  const child = spawn(host, args, {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: {
      SystemRoot: process.env.SystemRoot,
      WINDIR: process.env.WINDIR,
    },
  });
  const session = makeSession({ id, ownerId, metadata: input, sessionDirectory, child, storageBudget });
  sessions.set(id, session);

  child.stdout.on("data", (chunk: Buffer) => {
    child.stdout.pause();
    session.pcmChain = session.pcmChain.then(async () => {
      if (!session.recorder) throw new Error("Capture host sent PCM before the recording file was ready.");
      await session.recorder.writePcm(chunk);
    }).catch((error) => {
      failSession(session, error);
    }).finally(() => {
      child.stdout.resume();
    });
  });
  child.stderr.on("data", (chunk: Buffer) => queueNativeEvents(session, chunk));
  child.once("error", (error) => failSession(session, error));
  child.once("close", (code, signal) => {
    if (session.diskMonitor) {
      clearInterval(session.diskMonitor);
      session.diskMonitor = undefined;
    }
    const tail = session.stderrDecoder.end();
    if (tail) session.stderrBuffer += tail;
    if (session.stderrBuffer.trim()) {
      const lastLine = session.stderrBuffer;
      session.eventChain = session.eventChain.then(async () => {
        await handleNativeEvent(session, JSON.parse(lastLine) as NativeEvent);
      }).catch((error) => failSession(session, error));
      session.stderrBuffer = "";
    }
    session.endedAt = new Date().toISOString();
    if (code !== 0 || !session.nativeStopped) {
      if (!session.failure) session.failure = `Windows capture host exited unexpectedly (${code ?? signal ?? "unknown"}).`;
      session.status = "failed";
      session.rejectStarted(new Error(session.failure));
    }
    session.resolveClose({ code, signal });
  });

  const timeout = setTimeout(() => failSession(session, new Error("Windows capture host did not start in time.")), START_TIMEOUT_MS);
  try {
    await session.startedPromise;
    return snapshot(session);
  } catch (error) {
    sendStop(session);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export function getAudioCaptureStatus(ownerId: string, id: string): AudioCaptureSnapshot | null {
  const session = sessions.get(id);
  if (!session || session.ownerId !== ownerId) return null;
  return snapshot(session);
}

async function scanRecoverableAudioCaptures(ownerId: string): Promise<AudioCaptureRecoveryFile[]> {
  if (!process.env.ARENA_DATA_DIR) return [];
  const root = captureRoot();
  if (!existsSync(root)) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const recoveries: AudioCaptureRecoveryFile[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/i.test(entry.name)) continue;
    const session = sessions.get(entry.name);
    if (
      session &&
      (["starting", "recording", "stopping"].includes(session.status) ||
        (session.status === "failed" && session.child.exitCode === null && session.child.signalCode === null))
    ) continue;
    if (session?.status === "failed") {
      await session.closePromise;
      await session.eventChain;
      await session.pcmChain;
      if (session.recorder) await session.recorder.leaveRecoverable().catch(() => {});
    }

    const sessionDirectory = join(root, entry.name);
    const manifestPath = join(sessionDirectory, "session.json");
    if (!existsSync(manifestPath)) continue;
    let manifest: PersistedCaptureManifest;
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf8")) as PersistedCaptureManifest;
    } catch {
      continue;
    }
    if (
      manifest.sessionId !== entry.name ||
      manifest.ownerId !== ownerId ||
      typeof manifest.metadata?.title !== "string" ||
      typeof manifest.createdAt !== "string"
    ) continue;

    let recordingFile = manifest.recordingFile;
    if (
      !recordingFile ||
      recordingFile !== recordingFile.split(/[\\/]/).pop() ||
      !recordingFile.toLowerCase().endsWith(".wav") ||
      !existsSync(join(sessionDirectory, recordingFile))
    ) {
      if (existsSync(join(sessionDirectory, "recording.wav"))) {
        recordingFile = "recording.wav";
      }
    }
    if (
      !recordingFile ||
      recordingFile !== recordingFile.split(/[\\/]/).pop() ||
      !recordingFile.toLowerCase().endsWith(".wav") ||
      !existsSync(join(sessionDirectory, recordingFile))
    ) {
      const partialPath = join(sessionDirectory, "recording.partial.wav");
      if (!existsSync(partialPath)) continue;
      const recovered = await recoverRf64Partial(partialPath);
      recordingFile = recovered.path.split(/[\\/]/).pop();
      if (!recordingFile) continue;
      manifest.recordingFile = recordingFile;
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    }

    recoveries.push({
      sessionId: manifest.sessionId,
      title: manifest.metadata.title,
      ...(manifest.metadata.artist ? { artist: manifest.metadata.artist } : {}),
      ...(manifest.metadata.album ? { album: manifest.metadata.album } : {}),
      createdAt: manifest.createdAt,
      path: join(sessionDirectory, recordingFile),
      sessionDirectory,
    });
  }
  return recoveries.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(0, 100);
}

export async function listRecoverableAudioCaptures(ownerId: string): Promise<AudioCaptureRecovery[]> {
  return (await scanRecoverableAudioCaptures(ownerId)).map(({ path: _path, sessionDirectory: _directory, ...recovery }) => recovery);
}

export async function getRecoverableAudioCapture(ownerId: string, id: string): Promise<AudioCaptureRecoveryFile | null> {
  return (await scanRecoverableAudioCaptures(ownerId)).find((recovery) => recovery.sessionId === id) ?? null;
}

export function getAudioCaptureImportResult(ownerId: string, id: string): unknown | null {
  const session = sessions.get(id);
  return session?.ownerId === ownerId ? session.importedResponse ?? null : null;
}

export function setAudioCaptureImportResult(ownerId: string, id: string, value: unknown): void {
  const session = sessions.get(id);
  if (session?.ownerId === ownerId) session.importedResponse = value;
}

export function getAudioCaptureSessionDirectory(ownerId: string, id: string): string | null {
  const session = sessions.get(id);
  return session?.ownerId === ownerId ? session.sessionDirectory : null;
}

export function clearRecoveredAudioCapture(ownerId: string, id: string): void {
  const session = sessions.get(id);
  if (session?.ownerId === ownerId && (session.status === "failed" || session.status === "completed")) {
    sessions.delete(id);
  }
}

export function stopAudioCapture(ownerId: string, id: string): Promise<AudioCaptureFinalized | null> {
  const session = sessions.get(id);
  if (!session || session.ownerId !== ownerId) return Promise.resolve(null);
  if (session.stopPromise) return session.stopPromise;
  const operation = stopAudioCaptureSession(session);
  let shared: Promise<AudioCaptureFinalized | null>;
  shared = operation.finally(() => {
    if (session.stopPromise === shared) session.stopPromise = undefined;
  });
  session.stopPromise = shared;
  return shared;
}

async function stopAudioCaptureSession(session: CaptureSession): Promise<AudioCaptureFinalized> {
  if (session.status === "completed" && session.final) return session.final;
  if (session.status === "failed") {
    sendStop(session);
    await session.closePromise;
    await session.eventChain;
    await session.pcmChain;
    if (session.recorder) await session.recorder.leaveRecoverable().catch(() => {});
    throw new Error(session.failure || "The recording failed and was preserved for recovery.");
  }
  if (session.status !== "recording" && session.status !== "stopping") {
    throw new Error("The recording is not ready to stop.");
  }
  sendStop(session);
  const timeout = setTimeout(() => {
    if (session.child.exitCode === null) session.child.kill();
  }, STOP_TIMEOUT_MS);
  try {
    const close = await session.closePromise;
    await session.eventChain;
    await session.pcmChain;
    if (close.code !== 0 || !session.nativeStopped || session.failure) {
      if (session.recorder) await session.recorder.leaveRecoverable().catch(() => {});
      session.status = "failed";
      throw new Error(session.failure || "The Windows capture host did not stop cleanly; the partial recording was preserved.");
    }
    if (!session.recorder || !session.format) throw new Error("The capture file was not initialized.");
    let result: Rf64RecordingResult;
    try {
      result = await session.recorder.finalize();
    } catch {
      // A completed RF64 left under the partial name is recoverable without
      // copying or overwriting an existing user file.
      result = await recoverRf64Partial(session.partialPath);
    }
    session.status = "completed";
    session.final = {
      path: result.path,
      result,
      format: session.format,
      discontinuityCount: session.discontinuityCount,
      metadata: session.metadata,
      sessionDirectory: session.sessionDirectory,
    };
    const manifestPath = join(session.sessionDirectory, "session.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as PersistedCaptureManifest;
    manifest.recordingFile = basename(result.path);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    return session.final;
  } finally {
    clearTimeout(timeout);
  }
}

async function settlesWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<{ completed: true; value: T } | { completed: false }> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then((value) => ({ completed: true as const, value })),
      new Promise<{ completed: false }>((resolve) => {
        timer = setTimeout(() => resolve({ completed: false }), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Stop native capture children before the API exits. Audio is left as a
 * recoverable RF64 instead of being silently discarded or importing it while
 * the library/database are shutting down.
 */
export async function shutdownAudioCaptures(): Promise<AudioCaptureShutdownResult> {
  const pending = [...sessions.values()].filter((session) =>
    ["starting", "recording", "stopping"].includes(session.status) ||
    (session.status === "failed" && session.recorder && !session.final));
  const result: AudioCaptureShutdownResult = { stopped: 0, preserved: 0, forced: 0, unresponsive: 0 };

  await Promise.all(pending.map(async (session) => {
    if (!session.failure) session.failure = "Arena closed during recording; the audio was preserved for recovery.";
    if (session.status === "starting") {
      session.status = "failed";
      session.rejectStarted(new Error(session.failure));
      sendStop(session);
      let closed = await settlesWithin(session.closePromise, SHUTDOWN_STOP_TIMEOUT_MS);
      if (!closed.completed) {
        result.forced += 1;
        session.child.kill();
        closed = await settlesWithin(session.closePromise, SHUTDOWN_PIPE_SETTLE_TIMEOUT_MS);
      }
      if (!closed.completed) {
        result.unresponsive += 1;
        return;
      }
      const pipes = await settlesWithin(
        Promise.all([session.eventChain, session.pcmChain]),
        SHUTDOWN_PIPE_SETTLE_TIMEOUT_MS,
      );
      if (!pipes.completed) {
        result.unresponsive += 1;
        return;
      }
      result.stopped += 1;
      if (session.recorder) {
        try {
          await session.recorder.leaveRecoverable();
          result.preserved += 1;
        } catch {
          result.unresponsive += 1;
        }
      }
      return;
    }

    const gracefulStop = stopAudioCapture(session.ownerId, session.id).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    let stopped = await settlesWithin(gracefulStop, SHUTDOWN_STOP_TIMEOUT_MS + SHUTDOWN_PIPE_SETTLE_TIMEOUT_MS);
    if (!stopped.completed) {
      result.forced += 1;
      session.child.kill();
      stopped = await settlesWithin(gracefulStop, SHUTDOWN_PIPE_SETTLE_TIMEOUT_MS);
    }
    if (!stopped.completed) {
      result.unresponsive += 1;
      return;
    }

    result.stopped += 1;
    if (stopped.value.ok && stopped.value.value) {
      result.preserved += 1;
    } else if (!stopped.value.ok && session.recorder) {
      try {
        await session.recorder.leaveRecoverable();
        result.preserved += 1;
      } catch {
        result.unresponsive += 1;
      }
    }
  }));

  return result;
}

export async function removeAudioCaptureFiles(sessionDirectory: string): Promise<void> {
  await rm(sessionDirectory, { recursive: true, force: true });
}
