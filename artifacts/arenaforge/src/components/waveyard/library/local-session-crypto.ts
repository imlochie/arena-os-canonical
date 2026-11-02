import nacl from "tweetnacl";

export interface EncryptedLocalSessionPacket {
  senderId: string;
  counter: number;
  ciphertext: string;
}

export type LocalRemoteCommand =
  | { type: "toggle-play" }
  | { type: "next" }
  | { type: "previous" }
  | { type: "select-track"; itemId: string }
  | { type: "seek"; positionSeconds: number }
  | { type: "set-stem-level"; stemType: string; level: number }
  | { type: "isolate-stem"; stemType: string }
  | { type: "restore-mix" };

export function isLocalRemoteCommand(value: unknown): value is LocalRemoteCommand {
  if (value === null || typeof value !== "object") return false;
  const command = value as Record<string, unknown>;
  switch (command.type) {
    case "toggle-play":
    case "next":
    case "previous":
    case "restore-mix":
      return true;
    case "select-track":
      return typeof command.itemId === "string" && command.itemId.length > 0 && command.itemId.length <= 160;
    case "seek":
      return typeof command.positionSeconds === "number" && Number.isFinite(command.positionSeconds);
    case "set-stem-level":
      return typeof command.stemType === "string"
        && command.stemType.length > 0
        && command.stemType.length <= 40
        && typeof command.level === "number"
        && Number.isFinite(command.level)
        && command.level >= 0
        && command.level <= 2;
    case "isolate-stem":
      return typeof command.stemType === "string" && command.stemType.length > 0 && command.stemType.length <= 40;
    default:
      return false;
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export function toBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function fromBase64Url(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function createLocalSessionKey() {
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error("Arena must run from the desktop app to create a private QR link.");
  }
  return toBase64Url(globalThis.crypto.getRandomValues(new Uint8Array(nacl.secretbox.keyLength)));
}

function nonceFor(senderId: string, counter: number) {
  const prefix = fromBase64Url(senderId);
  if (prefix.length !== 16 || !Number.isSafeInteger(counter) || counter < 1) {
    throw new Error("Invalid local sync nonce.");
  }
  const nonce = new Uint8Array(nacl.secretbox.nonceLength);
  nonce.set(prefix);
  const view = new DataView(nonce.buffer);
  view.setUint32(16, Math.floor(counter / 0x1_0000_0000), false);
  view.setUint32(20, counter >>> 0, false);
  return nonce;
}

export function encryptLocalSessionPayload(
  keyBase64Url: string,
  senderId: string,
  counter: number,
  payload: unknown,
): EncryptedLocalSessionPacket {
  const key = fromBase64Url(keyBase64Url);
  if (key.length !== nacl.secretbox.keyLength) throw new Error("Invalid local sync key.");
  const ciphertext = nacl.secretbox(
    encoder.encode(JSON.stringify(payload)),
    nonceFor(senderId, counter),
    key,
  );
  return { senderId, counter, ciphertext: toBase64Url(ciphertext) };
}

export function decryptLocalSessionPayload<T>(
  keyBase64Url: string,
  packet: EncryptedLocalSessionPacket,
): T {
  const key = fromBase64Url(keyBase64Url);
  if (key.length !== nacl.secretbox.keyLength) throw new Error("Invalid local sync key.");
  const plaintext = nacl.secretbox.open(
    fromBase64Url(packet.ciphertext),
    nonceFor(packet.senderId, packet.counter),
    key,
  );
  if (plaintext === null) throw new Error("Local session message authentication failed.");
  return JSON.parse(decoder.decode(plaintext)) as T;
}
