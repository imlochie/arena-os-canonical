import { createHash, createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { Transform, Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { ARENA_BACKUP_SCOPES, ARENA_WAVEYARD_BACKUP_PARTS } from "./data-paths.mjs";

const FORMAT = "arena-data-backup";
const VERSION = 2;
const LEGACY_VERSION = 1;
const ENCRYPTION_ALGORITHM = "scrypt+aes-256-gcm";
const SCRYPT = { N: 32_768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const PASS_PHRASE_MIN_LENGTH = 12;
const MAX_INDEX_BYTES = 64 * 1024 * 1024;
const WAVEYARD_BACKUP_DIRS = ["storage", "capture"];

const sha256 = value => createHash("sha256").update(value).digest("hex");
const isWithin = (parent, child) => {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
};

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw new Error(`Could not determine whether PostgreSQL process ${pid} is running`, { cause: error });
  }
}

/** Return only a confirmed state. Invalid or unreadable lock state fails closed. */
export function postmasterState(dataDir, exists = processExists) {
  let text;
  try {
    text = readFileSync(path.join(dataDir, "postmaster.pid"), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return "stopped";
    throw new Error("Could not read PostgreSQL process state; refusing the backup.", { cause: error });
  }
  const firstLine = text.split(/\r?\n/, 1)[0];
  if (!/^[1-9]\d*$/.test(firstLine)) {
    throw new Error("PostgreSQL process state is uncertain; refusing the backup.");
  }
  const pid = Number(firstLine);
  if (!Number.isSafeInteger(pid)) throw new Error("PostgreSQL process state is uncertain; refusing the backup.");
  let running;
  try {
    running = exists(pid);
  } catch (error) {
    throw new Error("Could not determine PostgreSQL process state; refusing the backup.", { cause: error });
  }
  if (typeof running !== "boolean") throw new Error("PostgreSQL process state is uncertain; refusing the backup.");
  return running ? "running" : "stopped";
}

async function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(file).on("data", chunk => hash.update(chunk)).on("error", reject).on("end", () => resolve(hash.digest("hex")));
  });
}

async function hashTree(root) {
  const files = {};
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const relative = path.relative(root, full).split(path.sep).join("/");
      const stat = await lstat(full);
      if (stat.isDirectory()) await walk(full);
      else if (stat.isFile()) files[relative] = { bytes: stat.size, sha256: await hashFile(full) };
      else throw new Error(`Unsupported database backup entry: ${relative}`);
    }
  }
  await walk(root);
  return files;
}

const validScopeIds = new Set(ARENA_BACKUP_SCOPES.map(scope => scope.id));
const validWaveyardSelectionIds = new Set(ARENA_WAVEYARD_BACKUP_PARTS.map(part => part.id));
function normalizeScopes(scopes = []) {
  if (!Array.isArray(scopes) || scopes.some(id => !validScopeIds.has(id)) || new Set(scopes).size !== scopes.length) {
    throw new Error("The selected local backup scope is invalid.");
  }
  return [...scopes].sort();
}

function normalizeWaveyardSelection(selection = []) {
  if (!Array.isArray(selection) ||
    selection.some(id => !validWaveyardSelectionIds.has(id)) ||
    new Set(selection).size !== selection.length) {
    throw new Error("The selected Waveyard backup folders are invalid.");
  }
  return ARENA_WAVEYARD_BACKUP_PARTS.map(part => part.id).filter(id => selection.includes(id));
}

export function waveyardSelectionFromManifest(manifest) {
  if (manifest.waveyardSelection !== undefined) {
    const selection = normalizeWaveyardSelection(manifest.waveyardSelection);
    if (typeof manifest.includesWaveyardFiles !== "boolean" ||
      manifest.includesWaveyardFiles !== (selection.length > 0)) {
      throw new Error("This Arena backup has an invalid Waveyard-file selection.");
    }
    return selection;
  }
  if (manifest.version === LEGACY_VERSION) {
    const paths = Object.keys(manifest.files ?? {}).map(relative =>
      relative.startsWith("local/") ? relative.slice("local/".length) : relative,
    );
    return ARENA_WAVEYARD_BACKUP_PARTS
      .filter(part => paths.some(relative => relative.startsWith(`${part.relativePath}/`)))
      .map(part => part.id);
  }
  return manifest.includesWaveyardFiles === true
    ? ARENA_WAVEYARD_BACKUP_PARTS.map(part => part.id)
    : [];
}

function scopesFromManifest(manifest) {
  if (manifest.includesWaveyardFiles !== undefined && typeof manifest.includesWaveyardFiles !== "boolean") {
    throw new Error("This Arena backup has an invalid Waveyard-file selection.");
  }
  const scopes = normalizeScopes(manifest.localFolders ?? []);
  if (manifest.includesWaveyardFiles === true && !scopes.includes("waveyard-storage")) scopes.push("waveyard-storage");
  return scopes.sort();
}

async function findBrowserProfiles(root) {
  const workspaceRoot = path.join(root, "data/space-workspaces");
  let entries;
  try {
    const info = await lstat(workspaceRoot);
    if (!info.isDirectory()) throw new Error("The browser workspace path is not a regular folder; refusing to include browser profiles.");
    entries = await readdir(workspaceRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const profiles = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new Error("A browser workspace folder is a symbolic link; refusing to include browser profiles.");
    if (!entry.isDirectory()) continue;
    const relative = path.posix.join("data/space-workspaces", entry.name, "browser-profile");
    const full = path.join(root, ...relative.split("/"));
    try {
      const info = await lstat(full);
      if (!info.isDirectory()) throw new Error(`A browser profile is not a regular folder: ${relative}`);
      profiles.push(relative);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return profiles;
}

function isAllowedLocalPath(relative, scopes) {
  const parts = relative.split("/");
  if (parts[0] !== "local" || parts.some(part => !part || part === "." || part === "..") || relative.includes("\\")) return false;
  const localPath = parts.slice(1).join("/");
  if (scopes.includes("waveyard-storage") &&
    (localPath.startsWith("waveyard/storage/") || localPath.startsWith("waveyard/capture/"))) return true;
  if (scopes.includes("waveyard-models") && localPath.startsWith("waveyard/models/")) return true;
  if (scopes.includes("workspace-files") && localPath.startsWith("data/space-workspaces/") && !parts.includes("browser-profile")) return true;
  return scopes.includes("browser-profiles") &&
    /^data\/space-workspaces\/[^/]+\/browser-profile\/.+/.test(localPath);
}

function validateLegacyManifestFilePaths(manifest) {
  validateFileMap(manifest.files);
  const scopes = scopesFromManifest(manifest);
  for (const relative of Object.keys(manifest.files)) {
    const parts = relative.split("/");
    if (!isSafeRelativePath(relative)) throw new Error(`The backup manifest contains an unsafe path: ${relative}`);
    if (relative === "credential.enc" || parts[0] === "database" && parts.length > 1) continue;
    const waveyardFile = WAVEYARD_BACKUP_DIRS.some(directory =>
      relative.startsWith(`waveyard/${directory}/`),
    );
    if (waveyardFile && scopes.includes("waveyard-storage")) continue;
    if (isAllowedPlainPath(relative, scopes) || isAllowedLocalPath(relative, scopes)) continue;
    throw new Error(`The backup manifest contains an unsupported path: ${relative}`);
  }
}

function assertTreeMatches(expected, actual, label) {
  const mismatches = [];
  for (const [relative, entry] of Object.entries(expected)) {
    if (actual[relative]?.bytes !== entry.bytes || actual[relative]?.sha256 !== entry.sha256) {
      mismatches.push(`${relative}: missing or content differs`);
    }
  }
  for (const relative of Object.keys(actual)) {
    if (!Object.hasOwn(expected, relative)) mismatches.push(`${relative}: unexpected file`);
  }
  if (mismatches.length) throw new Error(`${label} verification failed: ${mismatches.slice(0, 5).join("; ")}`);
}

function decodeBase64(value, expectedBytes, label) {
  if (typeof value !== "string") throw new Error(`This Arena backup has invalid ${label} metadata.`);
  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== expectedBytes || decoded.toString("base64") !== value) {
    throw new Error(`This Arena backup has invalid ${label} metadata.`);
  }
  return decoded;
}

function isSafeRelativePath(relative) {
  if (typeof relative !== "string" || relative.length === 0 || relative.includes("\\") || path.posix.isAbsolute(relative)) {
    return false;
  }
  return relative.split("/").every(segment => segment.length > 0 && segment !== "." && segment !== ".." && !segment.includes(":"));
}

function isAllowedPlainPath(relative, scopesOrLegacyFlag) {
  if (!isSafeRelativePath(relative)) return false;
  if (relative === "runtime/db-password.json" || relative.startsWith("database/")) return true;
  const scopes = typeof scopesOrLegacyFlag === "boolean"
    ? (scopesOrLegacyFlag ? ["waveyard-storage"] : [])
    : scopesOrLegacyFlag;
  if (scopes.includes("waveyard-storage") && WAVEYARD_BACKUP_DIRS.some(directory =>
    relative.startsWith(`waveyard/${directory}/`),
  )) return true;
  if (scopes.includes("waveyard-models") && relative.startsWith("waveyard/models/")) return true;
  if (scopes.includes("workspace-files") &&
    relative.startsWith("data/space-workspaces/") &&
    !relative.split("/").includes("browser-profile")) return true;
  return scopes.includes("browser-profiles") &&
    /^data\/space-workspaces\/[^/]+\/browser-profile\/.+/.test(relative);
}

function isAllowedByWaveyardSelection(relative, selection) {
  const match = /^waveyard\/(storage|capture)\//.exec(relative);
  return match === null || selection.includes(match[1]);
}

function validateFileMap(files, label = "backup") {
  if (!files || typeof files !== "object" || Array.isArray(files)) {
    throw new Error(`This Arena ${label} has an invalid file list.`);
  }
  for (const [relative, entry] of Object.entries(files)) {
    if (!isSafeRelativePath(relative)) {
      throw new Error(`The backup manifest contains an unsafe path: ${relative}`);
    }
    if (!entry ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 0 ||
      typeof entry.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(entry.sha256)) {
      throw new Error(`This Arena ${label} has invalid file-integrity metadata.`);
    }
  }
}

function makeMeter(hash, count) {
  return new Transform({
    transform(chunk, encoding, callback) {
      hash.update(chunk);
      count.bytes += chunk.length;
      callback(null, chunk);
    },
  });
}

async function encryptStreamToFile(source, destination, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plainHash = createHash("sha256");
  const encryptedHash = createHash("sha256");
  const plainCount = { bytes: 0 };
  const encryptedCount = { bytes: 0 };
  await pipeline(
    source,
    makeMeter(plainHash, plainCount),
    cipher,
    makeMeter(encryptedHash, encryptedCount),
    createWriteStream(destination, { flags: "wx", mode: 0o600 }),
  );
  return {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    plainBytes: plainCount.bytes,
    plainSha256: plainHash.digest("hex"),
    encryptedBytes: encryptedCount.bytes,
    encryptedSha256: encryptedHash.digest("hex"),
  };
}

async function encryptFileToFile(source, destination, key) {
  return encryptStreamToFile(createReadStream(source), destination, key);
}

async function encryptBufferToFile(contents, destination, key) {
  return encryptStreamToFile(Readable.from([contents]), destination, key);
}

function decryptBuffer(contents, key, ivText, tagText, label) {
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, decodeBase64(ivText, 12, `${label} IV`));
    decipher.setAuthTag(decodeBase64(tagText, 16, `${label} authentication tag`));
    return Buffer.concat([decipher.update(contents), decipher.final()]);
  } catch (error) {
    throw new Error(`The backup passphrase is incorrect or the encrypted ${label} is damaged.`, { cause: error });
  }
}

async function decryptFileToFile(source, destination, key, ivText, tagText) {
  const decipher = createDecipheriv("aes-256-gcm", key, decodeBase64(ivText, 12, "file IV"));
  decipher.setAuthTag(decodeBase64(tagText, 16, "file authentication tag"));
  const authenticatedDecrypt = new Transform({
    transform(chunk, encoding, callback) {
      try {
        callback(null, decipher.update(chunk));
      } catch (error) {
        callback(error);
      }
    },
    flush(callback) {
      try {
        callback(null, decipher.final());
      } catch (error) {
        const authenticationError = new Error("AES-GCM file authentication failed.", { cause: error });
        authenticationError.code = "ARENA_BACKUP_AUTHENTICATION_FAILED";
        callback(authenticationError);
      }
    },
  });
  const plainHash = createHash("sha256");
  const plainCount = { bytes: 0 };
  await pipeline(
    createReadStream(source),
    authenticatedDecrypt,
    makeMeter(plainHash, plainCount),
    createWriteStream(destination, { flags: "wx", mode: 0o600 }),
  );
  return { bytes: plainCount.bytes, sha256: plainHash.digest("hex") };
}

async function collectDirectoryFiles(directory, prefix, { optional = false, excludeBrowserProfiles = false } = {}) {
  let rootStat;
  try {
    rootStat = await lstat(directory);
  } catch (error) {
    if (optional && error?.code === "ENOENT") return [];
    throw error;
  }
  if (!rootStat.isDirectory()) throw new Error(`${prefix} must be a real directory; refusing links or special files.`);
  const files = [];
  async function walk(current) {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (excludeBrowserProfiles && entry.name === "browser-profile") continue;
      const full = path.join(current, entry.name);
      const stat = await lstat(full);
      const subpath = path.relative(directory, full).split(path.sep).join("/");
      const relative = `${prefix}/${subpath}`;
      if (stat.isDirectory()) await walk(full);
      else if (stat.isFile()) files.push({ source: full, relative });
      else throw new Error(`Unsupported Arena backup entry: ${relative}`);
    }
  }
  await walk(directory);
  return files;
}

function backupKey(passphrase, salt) {
  return scryptSync(passphrase, salt, 32, SCRYPT);
}

function summarizeEntries(entries) {
  const databaseEntries = entries.filter(entry => entry.path.startsWith("database/"));
  const waveyardEntries = entries.filter(entry => {
    const relative = entry.path.startsWith("local/") ? entry.path.slice("local/".length) : entry.path;
    return relative.startsWith("waveyard/");
  });
  const optionalEntries = entries.filter(entry =>
    !entry.path.startsWith("database/") && entry.path !== "runtime/db-password.json",
  );
  return {
    databaseFileCount: databaseEntries.length,
    databaseBytes: databaseEntries.reduce((total, entry) => total + entry.plainBytes, 0),
    waveyardFileCount: waveyardEntries.length,
    waveyardBytes: waveyardEntries.reduce((total, entry) => total + entry.plainBytes, 0),
    localFileCount: optionalEntries.length,
    localBytes: optionalEntries.reduce((total, entry) => total + entry.plainBytes, 0),
  };
}

export function backupContentSummary(manifest) {
  if (manifest?.version === VERSION) return null;
  const entries = Object.entries(manifest?.files ?? {}).map(([relative, entry]) => ({
    path: relative === "credential.enc" ? "runtime/db-password.json" : relative,
    plainBytes: entry.bytes,
  }));
  return summarizeEntries(entries);
}

function validateV2Manifest(manifest) {
  validateFileMap(manifest.files);
  const scopes = scopesFromManifest(manifest);
  const waveyardSelection = waveyardSelectionFromManifest(manifest);
  if (typeof manifest.includesWaveyardFiles !== "boolean" ||
    manifest.includesWaveyardFiles !== scopes.includes("waveyard-storage") ||
    manifest.includesWaveyardFiles !== (waveyardSelection.length > 0) ||
    !/^\d+$/.test(String(manifest.pgVersion)) ||
    !manifest.encryption ||
    manifest.encryption.algorithm !== ENCRYPTION_ALGORITHM ||
    manifest.encryption.kdf?.name !== "scrypt" ||
    manifest.encryption.kdf.N !== SCRYPT.N ||
    manifest.encryption.kdf.r !== SCRYPT.r ||
    manifest.encryption.kdf.p !== SCRYPT.p ||
    manifest.encryption.index?.file !== "payload/index.enc") {
    throw new Error("This Arena backup has invalid encryption metadata.");
  }
  decodeBase64(manifest.encryption.kdf.salt, 16, "backup salt");
  decodeBase64(manifest.encryption.index.iv, 12, "index IV");
  decodeBase64(manifest.encryption.index.tag, 16, "index authentication tag");
  if (!Object.hasOwn(manifest.files, "payload/index.enc")) {
    throw new Error("This Arena backup is missing its encrypted file index.");
  }
  for (const relative of Object.keys(manifest.files)) {
    if (relative !== "payload/index.enc" && !/^payload\/[a-f0-9]{32}\.enc$/.test(relative)) {
      throw new Error(`This Arena backup contains an unsupported file: ${relative}`);
    }
  }
}

function validateEncryptedIndex(index, manifest) {
  const manifestWaveyardSelection = waveyardSelectionFromManifest(manifest);
  const indexWaveyardSelection = index?.waveyardSelection === undefined
    ? (index?.includesWaveyardFiles === true ? ARENA_WAVEYARD_BACKUP_PARTS.map(part => part.id) : [])
    : normalizeWaveyardSelection(index.waveyardSelection);
  if (index?.format !== FORMAT ||
    index.version !== VERSION ||
    index.pgVersion !== manifest.pgVersion ||
    index.includesWaveyardFiles !== manifest.includesWaveyardFiles ||
    JSON.stringify(indexWaveyardSelection) !== JSON.stringify(manifestWaveyardSelection) ||
    JSON.stringify(normalizeScopes(index.localFolders ?? (index.includesWaveyardFiles ? ["waveyard-storage"] : []))) !==
      JSON.stringify(scopesFromManifest(manifest)) ||
    !Array.isArray(index.entries)) {
    throw new Error("The encrypted Arena backup index does not match its manifest.");
  }
  const seenPaths = new Set();
  const seenPayloads = new Set();
  let hasCredential = false;
  let hasDatabaseVersion = false;
  for (const entry of index.entries) {
    if (!entry ||
      !isAllowedPlainPath(entry.path, scopesFromManifest(manifest)) ||
      !isAllowedByWaveyardSelection(entry.path, manifestWaveyardSelection) ||
      typeof entry.encryptedPath !== "string" ||
      !/^payload\/[a-f0-9]{32}\.enc$/.test(entry.encryptedPath) ||
      entry.encryptedPath === "payload/index.enc" ||
      !Number.isSafeInteger(entry.plainBytes) ||
      entry.plainBytes < 0 ||
      typeof entry.plainSha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(entry.plainSha256)) {
      throw new Error("The encrypted Arena backup index contains an invalid file entry.");
    }
    decodeBase64(entry.iv, 12, "file IV");
    decodeBase64(entry.tag, 16, "file authentication tag");
    if (seenPaths.has(entry.path) || seenPayloads.has(entry.encryptedPath)) {
      throw new Error("The encrypted Arena backup index contains duplicate file entries.");
    }
    seenPaths.add(entry.path);
    seenPayloads.add(entry.encryptedPath);
    if (!Object.hasOwn(manifest.files, entry.encryptedPath)) {
      throw new Error("The encrypted Arena backup index references a missing file.");
    }
    if (entry.path === "runtime/db-password.json") hasCredential = true;
    if (entry.path === "database/PG_VERSION") hasDatabaseVersion = true;
  }
  const actualPayloads = Object.keys(manifest.files).filter(relative => relative !== "payload/index.enc");
  if (actualPayloads.length !== seenPayloads.size || actualPayloads.some(relative => !seenPayloads.has(relative))) {
    throw new Error("The encrypted Arena backup index and file list do not match.");
  }
  if (!hasCredential || !hasDatabaseVersion) {
    throw new Error("The encrypted Arena backup is missing its database credential or version marker.");
  }
  const summary = summarizeEntries(index.entries);
  const requiredSummaryKeys = ["databaseFileCount", "databaseBytes", "waveyardFileCount", "waveyardBytes"];
  if (!index.summary ||
    requiredSummaryKeys.some(key =>
      !Number.isSafeInteger(index.summary[key]) || index.summary[key] !== summary[key],
    ) ||
    ["localFileCount", "localBytes"].some(key =>
      index.summary[key] !== undefined &&
      (!Number.isSafeInteger(index.summary[key]) || index.summary[key] !== summary[key]),
    )) {
    throw new Error("The encrypted Arena backup summary does not match its file index.");
  }
  return index.entries;
}

function decryptCredential(encrypted, passphrase) {
  const payload = JSON.parse(encrypted.toString("utf8"));
  if (payload.algorithm !== "scrypt+aes-256-gcm") throw new Error("Unsupported encrypted database credential format.");
  try {
    const key = scryptSync(passphrase, Buffer.from(payload.salt, "base64"), 32, SCRYPT);
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(payload.iv, "base64"));
    decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(payload.ciphertext, "base64")),
      decipher.final(),
    ]);
  } catch (error) {
    throw new Error("The backup passphrase is incorrect or its protected credential is damaged.", { cause: error });
  }
}

function validateCredential(contents) {
  let password;
  try {
    password = JSON.parse(contents.toString("utf8")).password;
  } catch (error) {
    throw new Error("The database credential file is not valid JSON.", { cause: error });
  }
  if (typeof password !== "string" || password.length < 16) {
    throw new Error("The database credential file is invalid.");
  }
}

function assertNewPassphrase(passphrase) {
  if (typeof passphrase !== "string" || passphrase.length < PASS_PHRASE_MIN_LENGTH) {
    throw new Error(`Use a backup passphrase with at least ${PASS_PHRASE_MIN_LENGTH} characters.`);
  }
}

async function readManifest(backupDir) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path.join(backupDir, "backup-manifest.json"), "utf8"));
  } catch (error) {
    throw new Error("This folder does not contain a readable Arena backup manifest.", { cause: error });
  }
  if (!manifest ||
    typeof manifest !== "object" ||
    Array.isArray(manifest) ||
    manifest.format !== FORMAT ||
    ![LEGACY_VERSION, VERSION].includes(manifest.version) ||
    !manifest.files ||
    typeof manifest.files !== "object" ||
    Array.isArray(manifest.files)) {
    throw new Error("This Arena backup uses an unsupported format.");
  }
  if (manifest.version === LEGACY_VERSION) validateLegacyManifestFilePaths(manifest);
  else validateV2Manifest(manifest);
  return manifest;
}

export async function readArenaBackupManifest(backupDir) {
  return readManifest(backupDir);
}

export async function verifyArenaBackup(backupDir) {
  const manifest = await readManifest(backupDir);
  const actual = await hashTree(backupDir);
  delete actual["backup-manifest.json"];
  const mismatches = [];
  for (const [relative, expected] of Object.entries(manifest.files)) {
    if (!actual[relative]) mismatches.push(`${relative}: missing`);
    else if (actual[relative].bytes !== expected.bytes || actual[relative].sha256 !== expected.sha256) mismatches.push(`${relative}: content differs`);
  }
  for (const relative of Object.keys(actual)) {
    if (!Object.hasOwn(manifest.files, relative)) mismatches.push(`${relative}: unexpected file`);
  }
  return { ok: mismatches.length === 0, manifest, mismatches };
}

async function readEncryptedIndex(backupDir, manifest, passphrase) {
  const key = backupKey(passphrase, decodeBase64(manifest.encryption.kdf.salt, 16, "backup salt"));
  try {
    const indexPath = path.join(backupDir, manifest.encryption.index.file);
    const stat = await lstat(indexPath);
    if (!stat.isFile() || stat.size > MAX_INDEX_BYTES) {
      throw new Error("The encrypted Arena backup index is not a supported size.");
    }
    const decrypted = decryptBuffer(
      await readFile(indexPath),
      key,
      manifest.encryption.index.iv,
      manifest.encryption.index.tag,
      "file index",
    );
    let index;
    try {
      index = JSON.parse(decrypted.toString("utf8"));
    } catch (error) {
      throw new Error("The encrypted Arena backup index is not valid JSON.", { cause: error });
    } finally {
      decrypted.fill(0);
    }
    const entries = validateEncryptedIndex(index, manifest);
    return { key, entries };
  } catch (error) {
    key.fill(0);
    throw error;
  }
}

async function assertEmptyRestoreTarget(target) {
  let stat;
  try {
    stat = await lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  if (!stat.isDirectory()) throw new Error("Restore requires a real, empty data folder; links and files are not accepted.");
  if ((await readdir(target)).length > 0) {
    throw new Error("Restore requires a new, empty Arena data folder.");
  }
  return true;
}

async function promoteRestore(staging, target) {
  const targetExisted = await assertEmptyRestoreTarget(target);
  if (targetExisted) await rmdir(target);
  try {
    await rename(staging, target);
  } catch (error) {
    if (targetExisted) await mkdir(target, { mode: 0o700 }).catch(() => {});
    throw error;
  }
}

async function restoreLegacyV1(source, staging, manifest, credential) {
  const postgresDir = path.join(staging, "data/postgres");
  await mkdir(path.dirname(postgresDir), { recursive: true, mode: 0o700 });
  await cp(path.join(source, "database"), postgresDir, { recursive: true, errorOnExist: true, force: false });
  const runtimeDir = path.join(staging, "runtime");
  await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  await writeFile(path.join(runtimeDir, "db-password.json"), credential, { flag: "wx", mode: 0o600 });
  const optionalEntries = Object.entries(manifest.files).filter(([relative]) =>
    relative !== "credential.enc" && !relative.startsWith("database/"),
  );
  for (const [relative, expected] of optionalEntries) {
    const targetRelative = relative.startsWith("local/") ? relative.slice("local/".length) : relative;
    const destination = path.join(staging, ...targetRelative.split("/"));
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await cp(path.join(source, ...relative.split("/")), destination, { errorOnExist: true, force: false });
    const stat = await lstat(destination);
    if (!stat.isFile() || stat.size !== expected.bytes || await hashFile(destination) !== expected.sha256) {
      throw new Error(`Restored local file verification failed: ${relative}`);
    }
  }

  const restoredDatabase = await hashTree(postgresDir);
  const expectedDatabase = Object.fromEntries(
    Object.entries(manifest.files)
      .filter(([relative]) => relative.startsWith("database/"))
      .map(([relative, entry]) => [relative.slice("database/".length), entry]),
  );
  assertTreeMatches(expectedDatabase, restoredDatabase, "Restored database");
  const restoredVersion = (await readFile(path.join(postgresDir, "PG_VERSION"), "utf8")).trim();
  if (restoredVersion !== manifest.pgVersion) throw new Error("Restored PostgreSQL version does not match the backup.");
  const waveyardEntries = optionalEntries.filter(([relative]) =>
    (relative.startsWith("local/") ? relative.slice("local/".length) : relative).startsWith("waveyard/"),
  );
  return {
    pgVersion: restoredVersion,
    fileCount: Object.keys(restoredDatabase).length,
    waveyardFileCount: waveyardEntries.length,
    waveyardBytes: waveyardEntries.reduce((total, [, entry]) => total + entry.bytes, 0),
    localFileCount: optionalEntries.length,
    localFolders: scopesFromManifest(manifest),
  };
}

function restoreDestinationPath(staging, logicalPath) {
  const segments = logicalPath.split("/");
  if (segments[0] === "database") return path.join(staging, "data", "postgres", ...segments.slice(1));
  return path.join(staging, ...segments);
}

async function restoreEncryptedV2(source, staging, manifest, entries, key) {
  for (const entry of entries) {
    const destination = restoreDestinationPath(staging, entry.path);
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    let decrypted;
    try {
      decrypted = await decryptFileToFile(
        path.join(source, entry.encryptedPath),
        destination,
        key,
        entry.iv,
        entry.tag,
      );
    } catch (error) {
      if (error?.code === "ARENA_BACKUP_AUTHENTICATION_FAILED") {
        throw new Error(`The backup passphrase is incorrect or encrypted file ${entry.encryptedPath} is damaged.`, { cause: error });
      }
      throw error;
    }
    if (decrypted.bytes !== entry.plainBytes || decrypted.sha256 !== entry.plainSha256) {
      throw new Error(`Restored file verification failed: ${entry.path}`);
    }
  }
  const credentialPath = path.join(staging, "runtime/db-password.json");
  const credential = await readFile(credentialPath);
  try {
    validateCredential(credential);
  } finally {
    credential.fill(0);
  }
  const postgresDir = path.join(staging, "data/postgres");
  const restoredDatabase = await hashTree(postgresDir);
  const expectedDatabase = Object.fromEntries(
    entries
      .filter(entry => entry.path.startsWith("database/"))
      .map(entry => [entry.path.slice("database/".length), { bytes: entry.plainBytes, sha256: entry.plainSha256 }]),
  );
  assertTreeMatches(expectedDatabase, restoredDatabase, "Restored database");
  const restoredWaveyard = existsSync(path.join(staging, "waveyard"))
    ? await hashTree(path.join(staging, "waveyard"))
    : {};
  const expectedWaveyard = Object.fromEntries(
    entries
      .filter(entry => entry.path.startsWith("waveyard/"))
      .map(entry => [entry.path.slice("waveyard/".length), { bytes: entry.plainBytes, sha256: entry.plainSha256 }]),
  );
  assertTreeMatches(expectedWaveyard, restoredWaveyard, "Restored Waveyard files");
  const restoredVersion = (await readFile(path.join(postgresDir, "PG_VERSION"), "utf8")).trim();
  if (restoredVersion !== manifest.pgVersion) throw new Error("Restored PostgreSQL version does not match the backup.");
  const waveyardEntries = entries.filter(entry => entry.path.startsWith("waveyard/"));
  return {
    pgVersion: restoredVersion,
    fileCount: Object.keys(restoredDatabase).length,
    waveyardFileCount: waveyardEntries.length,
    waveyardBytes: waveyardEntries.reduce((total, entry) => total + entry.plainBytes, 0),
    localFileCount: entries.filter(entry =>
      !entry.path.startsWith("database/") && entry.path !== "runtime/db-password.json",
    ).length,
    localFolders: scopesFromManifest(manifest),
  };
}

export async function createArenaBackup({
  root,
  parentDir,
  passphrase,
  databaseStopped,
  includeWaveyardFiles,
  waveyardSelection: requestedWaveyardSelection,
  localFolders,
  now = () => new Date(),
  processExists: exists = processExists,
}) {
  assertNewPassphrase(passphrase);
  if (includeWaveyardFiles !== undefined && typeof includeWaveyardFiles !== "boolean") {
    throw new Error("Choose whether Waveyard files should be included in the Arena backup.");
  }
  const scopes = normalizeScopes(localFolders ?? []);
  const waveyardSelection = requestedWaveyardSelection === undefined
    ? (includeWaveyardFiles === true || scopes.includes("waveyard-storage")
      ? ARENA_WAVEYARD_BACKUP_PARTS.map(part => part.id)
      : [])
    : normalizeWaveyardSelection(requestedWaveyardSelection);
  if (includeWaveyardFiles === false &&
    (scopes.includes("waveyard-storage") || waveyardSelection.length > 0)) {
    throw new Error("Waveyard files cannot be both selected and excluded from this backup.");
  }
  if (includeWaveyardFiles === true && waveyardSelection.length === 0) {
    throw new Error("Waveyard files cannot be both excluded and selected from this backup.");
  }
  if (requestedWaveyardSelection !== undefined &&
    scopes.includes("waveyard-storage") && waveyardSelection.length === 0) {
    throw new Error("Waveyard files cannot be both selected and excluded from this backup.");
  }
  if (waveyardSelection.length > 0 && !scopes.includes("waveyard-storage")) scopes.push("waveyard-storage");
  scopes.sort();
  if (databaseStopped !== true) {
    throw new Error("Arena has not confirmed a clean database shutdown; refusing the backup.");
  }
  const dataDir = path.join(root, "data/postgres");
  if (postmasterState(dataDir, exists) !== "stopped") {
    throw new Error("PostgreSQL is still running; Arena will not copy a live database.");
  }
  const databaseFiles = await collectDirectoryFiles(dataDir, "database");
  if (!databaseFiles.some(file => file.relative === "database/PG_VERSION")) {
    throw new Error("The database version marker is missing; refusing the backup.");
  }
  const version = (await readFile(path.join(dataDir, "PG_VERSION"), "utf8")).trim();
  if (!/^\d+$/.test(version)) throw new Error("The database version could not be verified; refusing the backup.");
  const credentialPath = path.join(root, "runtime/db-password.json");
  const credential = await readFile(credentialPath);
  validateCredential(credential);
  const sourceFiles = [
    ...databaseFiles,
    { source: credentialPath, relative: "runtime/db-password.json", buffer: credential },
  ];
  for (const part of ARENA_WAVEYARD_BACKUP_PARTS) {
    if (!waveyardSelection.includes(part.id)) continue;
    sourceFiles.push(...await collectDirectoryFiles(
      path.join(root, ...part.relativePath.split("/")),
      part.relativePath,
      { optional: true },
    ));
  }
  if (scopes.includes("waveyard-models")) {
    sourceFiles.push(...await collectDirectoryFiles(path.join(root, "waveyard/models"), "waveyard/models", { optional: true }));
  }
  if (scopes.includes("workspace-files")) {
    sourceFiles.push(...await collectDirectoryFiles(path.join(root, "data/space-workspaces"), "data/space-workspaces", {
      optional: true,
      excludeBrowserProfiles: true,
    }));
  }
  if (scopes.includes("browser-profiles")) {
    for (const relative of await findBrowserProfiles(root)) {
      sourceFiles.push(...await collectDirectoryFiles(path.join(root, ...relative.split("/")), relative));
    }
  }
  const sourcePaths = new Set();
  for (const file of sourceFiles) {
    if (!isAllowedPlainPath(file.relative, scopes) || sourcePaths.has(file.relative)) {
      throw new Error(`Unsupported or duplicate Arena backup entry: ${file.relative}`);
    }
    sourcePaths.add(file.relative);
  }

  const timestamp = now().toISOString().replace(/[:.]/g, "-");
  const backupDir = path.join(parentDir, `Arena-data-${timestamp}`);
  const sourceRoot = path.resolve(root);
  if (isWithin(sourceRoot, backupDir) || isWithin(backupDir, sourceRoot)) {
    throw new Error("Choose a backup destination outside the current Arena data folder.");
  }
  await mkdir(backupDir, { recursive: false });
  let key;
  try {
    const payloadDir = path.join(backupDir, "payload");
    await mkdir(payloadDir, { mode: 0o700 });
    const salt = randomBytes(16);
    key = backupKey(passphrase, salt);
    const entries = [];
    const files = {};
    for (const file of sourceFiles) {
      const encryptedPath = `payload/${randomBytes(16).toString("hex")}.enc`;
      const destination = path.join(backupDir, encryptedPath);
      let encrypted;
      if (file.buffer) {
        try {
          encrypted = await encryptBufferToFile(file.buffer, destination, key);
        } finally {
          file.buffer.fill(0);
        }
      } else {
        encrypted = await encryptFileToFile(file.source, destination, key);
      }
      entries.push({
        path: file.relative,
        encryptedPath,
        plainBytes: encrypted.plainBytes,
        plainSha256: encrypted.plainSha256,
        iv: encrypted.iv,
        tag: encrypted.tag,
      });
      files[encryptedPath] = {
        bytes: encrypted.encryptedBytes,
        sha256: encrypted.encryptedSha256,
      };
    }
    const summary = summarizeEntries(entries);
    const indexContents = Buffer.from(JSON.stringify({
      format: FORMAT,
      version: VERSION,
      pgVersion: version,
      includesWaveyardFiles: waveyardSelection.length > 0,
      waveyardSelection,
      localFolders: scopes,
      summary,
      entries,
    }));
    if (indexContents.byteLength > MAX_INDEX_BYTES) {
      throw new Error("The backup file list is too large to encrypt safely.");
    }
    let encryptedIndex;
    try {
      encryptedIndex = await encryptBufferToFile(
        indexContents,
        path.join(payloadDir, "index.enc"),
        key,
      );
    } finally {
      indexContents.fill(0);
    }
    files["payload/index.enc"] = {
      bytes: encryptedIndex.encryptedBytes,
      sha256: encryptedIndex.encryptedSha256,
    };
    const manifest = {
      format: FORMAT,
      version: VERSION,
      createdAt: now().toISOString(),
      pgVersion: version,
      includesWaveyardFiles: waveyardSelection.length > 0,
      waveyardSelection,
      localFolders: scopes,
      scope: `Encrypted PostgreSQL database, matching credential, and selected local folders (${scopes.join(", ") || "none"}). Browser profiles are excluded unless explicitly selected.`,
      encryption: {
        algorithm: ENCRYPTION_ALGORITHM,
        kdf: {
          name: "scrypt",
          N: SCRYPT.N,
          r: SCRYPT.r,
          p: SCRYPT.p,
          salt: salt.toString("base64"),
        },
        index: {
          file: "payload/index.enc",
          iv: encryptedIndex.iv,
          tag: encryptedIndex.tag,
        },
      },
      files,
    };
    await writeFile(path.join(backupDir, "backup-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    const verified = await verifyArenaBackup(backupDir);
    if (!verified.ok) throw new Error(`Backup verification failed: ${verified.mismatches.slice(0, 5).join("; ")}`);
    return { backupDir, manifest, summary };
  } catch (error) {
    await rm(backupDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  } finally {
    key?.fill(0);
    credential.fill(0);
  }
}

export async function restoreArenaBackup({ backupDir, targetRoot, passphrase }) {
  assertNewPassphrase(passphrase);
  const verified = await verifyArenaBackup(backupDir);
  if (!verified.ok) {
    throw new Error(`Backup verification failed; refusing to restore: ${verified.mismatches.slice(0, 5).join("; ")}`);
  }
  const target = path.resolve(targetRoot);
  const source = path.resolve(backupDir);
  if (isWithin(source, target) || isWithin(target, source)) {
    throw new Error("The new Arena data folder must not overlap the backup folder.");
  }
  await assertEmptyRestoreTarget(target);

  const manifest = verified.manifest;
  let credential;
  let key;
  let encryptedEntries;
  if (manifest.version === LEGACY_VERSION) {
    credential = decryptCredential(await readFile(path.join(source, "credential.enc")), passphrase);
    validateCredential(credential);
    if (sha256(credential) !== manifest.credentialSha256) {
      throw new Error("The protected database credential failed verification; nothing was restored.");
    }
  } else {
    const encryptedIndex = await readEncryptedIndex(source, manifest, passphrase);
    key = encryptedIndex.key;
    encryptedEntries = encryptedIndex.entries;
  }

  let staging;
  try {
    await mkdir(path.dirname(target), { recursive: true });
    staging = await mkdtemp(path.join(path.dirname(target), ".arena-restore-"));
    const restored = manifest.version === LEGACY_VERSION
      ? await restoreLegacyV1(source, staging, manifest, credential)
      : await restoreEncryptedV2(source, staging, manifest, encryptedEntries, key);
    await promoteRestore(staging, target);
    return { targetRoot: target, ...restored };
  } catch (error) {
    if (staging) await rm(staging, { recursive: true, force: true }).catch(() => {});
    throw error;
  } finally {
    key?.fill(0);
    credential?.fill(0);
  }
}
