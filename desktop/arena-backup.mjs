import { createHash, createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const FORMAT = "arena-data-backup";
const VERSION = 1;
const SCRYPT = { N: 32_768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const PASS_PHRASE_MIN_LENGTH = 12;

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

function encryptedCredential(credential, passphrase) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(passphrase, salt, 32, SCRYPT);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(credential), cipher.final()]);
  return Buffer.from(JSON.stringify({
    algorithm: "scrypt+aes-256-gcm",
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  }));
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
  if (manifest.format !== FORMAT || manifest.version !== VERSION || !manifest.files || typeof manifest.files !== "object") {
    throw new Error("This Arena backup uses an unsupported format.");
  }
  return manifest;
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

export async function createArenaBackup({ root, parentDir, passphrase, databaseStopped, now = () => new Date(), processExists: exists = processExists }) {
  assertNewPassphrase(passphrase);
  if (databaseStopped !== true) {
    throw new Error("Arena has not confirmed a clean database shutdown; refusing the backup.");
  }
  const dataDir = path.join(root, "data/postgres");
  if (postmasterState(dataDir, exists) !== "stopped") {
    throw new Error("PostgreSQL is still running; Arena will not copy a live database.");
  }
  const version = (await readFile(path.join(dataDir, "PG_VERSION"), "utf8")).trim();
  if (!/^\d+$/.test(version)) throw new Error("The database version could not be verified; refusing the backup.");
  const credentialPath = path.join(root, "runtime/db-password.json");
  const credential = await readFile(credentialPath);
  validateCredential(credential);
  const sourceDatabaseFiles = await hashTree(dataDir);

  const timestamp = now().toISOString().replace(/[:.]/g, "-");
  const backupDir = path.join(parentDir, `Arena-data-${timestamp}`);
  const sourceRoot = path.resolve(root);
  if (isWithin(sourceRoot, backupDir) || isWithin(backupDir, sourceRoot)) {
    throw new Error("Choose a backup destination outside the current Arena data folder.");
  }
  await mkdir(backupDir, { recursive: false });
  try {
    await cp(dataDir, path.join(backupDir, "database"), { recursive: true, errorOnExist: true, force: false });
    await writeFile(path.join(backupDir, "credential.enc"), encryptedCredential(credential, passphrase), { flag: "wx", mode: 0o600 });
    const files = await hashTree(backupDir);
    const copiedDatabaseFiles = Object.fromEntries(
      Object.entries(files)
        .filter(([relative]) => relative.startsWith("database/"))
        .map(([relative, entry]) => [relative.slice("database/".length), entry]),
    );
    assertTreeMatches(sourceDatabaseFiles, copiedDatabaseFiles, "Copied database");
    const manifest = {
      format: FORMAT,
      version: VERSION,
      createdAt: now().toISOString(),
      pgVersion: version,
      scope: "PostgreSQL database and its encrypted matching credential only. Waveyard files, downloaded models, browser profiles, and other files are excluded.",
      credentialSha256: sha256(credential),
      files,
    };
    await writeFile(path.join(backupDir, "backup-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    const verified = await verifyArenaBackup(backupDir);
    if (!verified.ok) throw new Error(`Backup verification failed: ${verified.mismatches.slice(0, 5).join("; ")}`);
    return { backupDir, manifest };
  } catch (error) {
    await rm(backupDir, { recursive: true, force: true }).catch(() => {});
    throw error;
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
  if (existsSync(target)) {
    const entries = await readdir(target);
    if (entries.length > 0) throw new Error("Restore requires a new, empty Arena data folder.");
  }
  const credential = decryptCredential(await readFile(path.join(source, "credential.enc")), passphrase);
  validateCredential(credential);
  if (sha256(credential) !== verified.manifest.credentialSha256) {
    throw new Error("The protected database credential failed verification; nothing was restored.");
  }
  await mkdir(target, { recursive: true });
  const postgresDir = path.join(target, "data/postgres");
  await mkdir(path.dirname(postgresDir), { recursive: true });
  await cp(path.join(source, "database"), postgresDir, { recursive: true, errorOnExist: true, force: false });
  const runtimeDir = path.join(target, "runtime");
  await mkdir(runtimeDir, { recursive: true });
  await writeFile(path.join(runtimeDir, "db-password.json"), credential, { flag: "wx", mode: 0o600 });
  const restored = await hashTree(postgresDir);
  const expectedDatabase = Object.fromEntries(
    Object.entries(verified.manifest.files)
      .filter(([relative]) => relative.startsWith("database/"))
      .map(([relative, entry]) => [relative.slice("database/".length), entry]),
  );
  const restoredErrors = [];
  for (const [relative, expected] of Object.entries(expectedDatabase)) {
    if (restored[relative]?.sha256 !== expected.sha256 || restored[relative]?.bytes !== expected.bytes) restoredErrors.push(relative);
  }
  if (Object.keys(restored).length !== Object.keys(expectedDatabase).length || restoredErrors.length > 0) {
    throw new Error(`Restored database verification failed: ${restoredErrors.slice(0, 5).join(", ") || "file count differs"}`);
  }
  const restoredVersion = (await readFile(path.join(postgresDir, "PG_VERSION"), "utf8")).trim();
  if (restoredVersion !== verified.manifest.pgVersion) throw new Error("Restored PostgreSQL version does not match the backup.");
  return { targetRoot: target, pgVersion: restoredVersion, fileCount: Object.keys(restored).length };
}
