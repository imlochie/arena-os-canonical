import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { networkInterfaces } from "node:os";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { readFile } from "node:fs/promises";

const MAX_PACKET_BYTES = 16 * 1024;
const MAX_REMOTE_DEVICES = 4;
const SESSION_TTL_MS = 60 * 60 * 1000;

type RemoteDevice = {
  id: string;
  token: string;
  lastCommandAt: number;
};

type ActiveSync = {
  hostOrigin: string;
  server: Server;
  pairingToken: string;
  hostToken: string;
  hostNoncePrefix: string;
  remoteDevices: Map<string, RemoteDevice>;
  hostStreams: Set<ServerResponse>;
  remoteStreams: Set<ServerResponse>;
  latestState: string | null;
  expiresAt: number;
  expiryTimer: ReturnType<typeof setTimeout>;
  privateAddresses: string[];
  closed: boolean;
};

let active: ActiveSync | null = null;

function privateIpv4(address: string) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168);
}

export function waveyardLocalSyncAddresses() {
  const addresses = new Set<string>();
  for (const interfaces of Object.values(networkInterfaces())) {
    for (const entry of interfaces ?? []) {
      if (entry.family === "IPv4" && !entry.internal && privateIpv4(entry.address)) addresses.add(entry.address);
    }
  }
  return [...addresses];
}

function sameSecret(actual: string | null | undefined, expected: string) {
  if (!actual) return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function sendJson(res: ServerResponse, status: number, value: unknown) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(body);
}

function sendSse(res: ServerResponse, event: string, value: unknown) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
}

function attachSse(res: ServerResponse, clients: Set<ServerResponse>) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.write(": connected\n\n");
  clients.add(res);
  const keepAlive = setInterval(() => res.write(": keepalive\n\n"), 15_000);
  keepAlive.unref?.();
  res.on("close", () => {
    clearInterval(keepAlive);
    clients.delete(res);
  });
}

function broadcast(clients: Set<ServerResponse>, event: string, payload: unknown) {
  for (const client of clients) {
    if (!client.destroyed) sendSse(client, event, payload);
  }
}

function getToken(req: IncomingMessage) {
  const authorization = req.headers.authorization;
  if (authorization?.startsWith("Bearer ")) return authorization.slice(7);
  const url = new URL(req.url ?? "/", "http://local-sync");
  return url.searchParams.get("token");
}

function originAllowed(req: IncomingMessage, state: ActiveSync) {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (origin === state.hostOrigin) return true;
  const host = req.headers.host;
  return typeof host === "string" && origin === `http://${host}`;
}

function corsHeaders(req: IncomingMessage, res: ServerResponse, state: ActiveSync) {
  if (req.headers.origin === state.hostOrigin) {
    res.setHeader("access-control-allow-origin", state.hostOrigin);
    res.setHeader("access-control-allow-headers", "authorization, content-type");
    res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
    res.setHeader("vary", "Origin");
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_PACKET_BYTES) throw new Error("PAYLOAD_TOO_LARGE");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("INVALID_JSON");
  }
}

function remotePageHeaders(res: ServerResponse) {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'",
  });
}

async function serveRemotePage(res: ServerResponse) {
  const root = process.env.ARENA_WEB_ROOT;
  if (!root || !isAbsolute(root)) {
    sendJson(res, 503, { error: "The packaged Waveyard remote page is unavailable." });
    return;
  }
  try {
    const page = await readFile(join(root, "waveyard-remote.html"));
    remotePageHeaders(res);
    res.end(page);
  } catch {
    sendJson(res, 503, { error: "The packaged Waveyard remote page is unavailable." });
  }
}

async function serveRemoteAsset(pathname: string, res: ServerResponse) {
  const root = process.env.ARENA_WEB_ROOT;
  const match = pathname.match(/^\/assets\/([A-Za-z0-9._-]+)$/);
  if (!root || !isAbsolute(root) || !match) {
    sendJson(res, 404, { error: "Not found." });
    return;
  }
  const assetRoot = resolve(root, "assets");
  const filePath = resolve(assetRoot, match[1]);
  const relativeAssetPath = relative(assetRoot, filePath);
  if (!relativeAssetPath || relativeAssetPath.startsWith("..") || isAbsolute(relativeAssetPath)) {
    sendJson(res, 404, { error: "Not found." });
    return;
  }
  try {
    const content = await readFile(filePath);
    const type = extname(filePath) === ".js" ? "text/javascript; charset=utf-8"
      : extname(filePath) === ".css" ? "text/css; charset=utf-8"
        : extname(filePath) === ".svg" ? "image/svg+xml"
          : extname(filePath) === ".woff2" ? "font/woff2"
            : "application/octet-stream";
    res.writeHead(200, {
      "content-type": type,
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    });
    res.end(content);
  } catch {
    sendJson(res, 404, { error: "Not found." });
  }
}

async function handleRequest(state: ActiveSync, req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://local-sync");
  corsHeaders(req, res, state);
  res.setHeader("cache-control", "no-store");
  if (state.closed) {
    sendJson(res, 401, { error: "This pairing ended. Scan a fresh QR from Waveyard." });
    return;
  }

  if (req.method === "OPTIONS") {
    if (!originAllowed(req, state)) {
      sendJson(res, 403, { error: "Origin not allowed." });
      return;
    }
    res.writeHead(204, {
      "access-control-allow-headers": "authorization, content-type",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-max-age": "300",
    });
    res.end();
    return;
  }

  if (req.method === "GET" && url.pathname === "/") {
    await serveRemotePage(res);
    return;
  }
  if (req.method === "GET" && url.pathname.startsWith("/assets/")) {
    await serveRemoteAsset(url.pathname, res);
    return;
  }
  if (!originAllowed(req, state)) {
    sendJson(res, 403, { error: "Origin not allowed." });
    return;
  }

  if (req.method === "GET" && url.pathname === "/join") {
    if (!sameSecret(url.searchParams.get("pair"), state.pairingToken)) {
      sendJson(res, 401, { error: "This pairing code is invalid or has expired." });
      return;
    }
    if (state.remoteDevices.size >= MAX_REMOTE_DEVICES) {
      sendJson(res, 429, { error: "This session already has the maximum number of paired phones." });
      return;
    }
    const device = {
      id: randomBytes(16).toString("base64url"),
      token: randomBytes(32).toString("base64url"),
      lastCommandAt: 0,
    };
    state.remoteDevices.set(device.id, device);
    broadcast(state.hostStreams, "device", { connected: true, count: state.remoteDevices.size });
    sendJson(res, 200, {
      deviceId: device.id,
      deviceToken: device.token,
      expiresAt: state.expiresAt,
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/events") {
    const device = [...state.remoteDevices.values()].find((candidate) => sameSecret(getToken(req), candidate.token));
    if (!device) {
      sendJson(res, 401, { error: "Pair this phone again to reconnect." });
      return;
    }
    if (state.remoteStreams.size >= MAX_REMOTE_DEVICES) {
      sendJson(res, 429, { error: "The phone stream limit has been reached." });
      return;
    }
    attachSse(res, state.remoteStreams);
    if (state.latestState) sendSse(res, "state", JSON.parse(state.latestState));
    return;
  }

  if (req.method === "POST" && url.pathname === "/control") {
    const device = [...state.remoteDevices.values()].find((candidate) => sameSecret(getToken(req), candidate.token));
    if (!device) {
      sendJson(res, 401, { error: "Pair this phone again to reconnect." });
      return;
    }
    const now = Date.now();
    if (now - device.lastCommandAt < 80) {
      sendJson(res, 429, { error: "Control updates are arriving too quickly." });
      return;
    }
    device.lastCommandAt = now;
    const body = await readJson(req) as { packet?: unknown };
    const packet = body?.packet as Partial<{ senderId: string; counter: number; ciphertext: string }> | undefined;
    if (
      !packet
      || packet.senderId !== device.id
      || !Number.isSafeInteger(packet.counter)
      || (packet.counter ?? 0) < 1
      || typeof packet.ciphertext !== "string"
      || packet.ciphertext.length > MAX_PACKET_BYTES
    ) {
      sendJson(res, 400, { error: "Encrypted control packet is required." });
      return;
    }
    broadcast(state.hostStreams, "control", packet);
    sendJson(res, 202, { accepted: true });
    return;
  }

  if (req.method === "GET" && url.pathname === "/host/events") {
    if (!sameSecret(getToken(req), state.hostToken)) {
      sendJson(res, 401, { error: "Host session is not authorized." });
      return;
    }
    attachSse(res, state.hostStreams);
    return;
  }

  if (req.method === "POST" && url.pathname === "/host/state") {
    if (!sameSecret(getToken(req), state.hostToken)) {
      sendJson(res, 401, { error: "Host session is not authorized." });
      return;
    }
    const body = await readJson(req) as { packet?: unknown };
    const packet = body?.packet as Partial<{ senderId: string; counter: number; ciphertext: string }> | undefined;
    if (
      !packet
      || packet.senderId !== state.hostNoncePrefix
      || !Number.isSafeInteger(packet.counter)
      || (packet.counter ?? 0) < 1
      || typeof packet.ciphertext !== "string"
      || packet.ciphertext.length > MAX_PACKET_BYTES
    ) {
      sendJson(res, 400, { error: "Encrypted state packet is required." });
      return;
    }
    const serialized = JSON.stringify(packet);
    if (Buffer.byteLength(serialized) > MAX_PACKET_BYTES) {
      sendJson(res, 413, { error: "State packet is too large." });
      return;
    }
    state.latestState = serialized;
    broadcast(state.remoteStreams, "state", body.packet);
    res.writeHead(204, { "cache-control": "no-store" });
    res.end();
    return;
  }

  sendJson(res, 404, { error: "Not found." });
}

async function closeActiveSync(state: ActiveSync, reason = "stopped") {
  state.closed = true;
  if (active === state) active = null;
  clearTimeout(state.expiryTimer);
  state.remoteDevices.clear();
  state.latestState = null;
  broadcast(state.remoteStreams, "ended", { reason });
  broadcast(state.hostStreams, "ended", { reason });
  for (const client of state.hostStreams) client.end();
  for (const client of state.remoteStreams) client.end();
  state.hostStreams.clear();
  state.remoteStreams.clear();
  await new Promise<void>((resolve) => {
    if (!state.server.listening) {
      resolve();
      return;
    }
    state.server.close(() => resolve());
    state.server.closeAllConnections();
  });
}

let starting: Promise<unknown> = Promise.resolve();

export function startWaveyardLocalSync(input: { hostOrigin: string }) {
  const result = starting.then(() => startLocalSync(input));
  starting = result.catch(() => undefined);
  return result;
}

async function startLocalSync(input: { hostOrigin: string }) {
  if (process.env.ARENA_DESKTOP_MODE !== "1") {
    throw new Error("LOCAL_SYNC_DESKTOP_ONLY");
  }
  const origin = new URL(input.hostOrigin);
  if (origin.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(origin.hostname)) {
    throw new Error("LOCAL_SYNC_HOST_ORIGIN_INVALID");
  }
  if (active) await closeActiveSync(active, "replaced");
  const addresses = waveyardLocalSyncAddresses();
  if (addresses.length === 0) throw new Error("LOCAL_SYNC_NO_PRIVATE_NETWORK");

  const pairingToken = randomBytes(32).toString("base64url");
  const hostToken = randomBytes(32).toString("base64url");
  const hostNoncePrefix = randomBytes(16).toString("base64url");
  const server = createServer();
  const state: ActiveSync = {
    hostOrigin: origin.origin,
    server,
    pairingToken,
    hostToken,
    hostNoncePrefix,
    remoteDevices: new Map(),
    hostStreams: new Set(),
    remoteStreams: new Set(),
    latestState: null,
    expiresAt: Date.now() + SESSION_TTL_MS,
    expiryTimer: setTimeout(() => { void closeActiveSync(state, "expired"); }, SESSION_TTL_MS),
    privateAddresses: addresses,
    closed: false,
  };
  state.expiryTimer.unref?.();
  server.on("request", (req, res) => {
    void handleRequest(state, req, res).catch((error) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      const status = error instanceof Error && error.message === "PAYLOAD_TOO_LARGE" ? 413 : 400;
      sendJson(res, status, { error: status === 413 ? "Message is too large." : "Request could not be processed." });
    });
  });

  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(0, "0.0.0.0", () => resolveListen());
    });
  } catch (error) {
    clearTimeout(state.expiryTimer);
    throw error;
  }
  active = state;
  return {
    addresses: state.privateAddresses,
    port: (server.address() as AddressInfo).port,
    pairingToken,
    hostToken,
    hostNoncePrefix,
    expiresAt: state.expiresAt,
    maxDevices: MAX_REMOTE_DEVICES,
  };
}

export function getWaveyardLocalSyncStatus(
  hostToken: string,
  selectedAddress: string,
  addresses = waveyardLocalSyncAddresses(),
) {
  if (!active) return { active: false, addresses: [], selectedAddressAvailable: false };
  if (!sameSecret(hostToken, active.hostToken)) throw new Error("LOCAL_SYNC_HOST_UNAUTHORIZED");
  return { active: true, addresses, selectedAddressAvailable: addresses.includes(selectedAddress) };
}

export async function stopWaveyardLocalSync(hostToken: string) {
  if (!active) return false;
  if (!sameSecret(hostToken, active.hostToken)) throw new Error("LOCAL_SYNC_HOST_UNAUTHORIZED");
  await closeActiveSync(active);
  return true;
}
