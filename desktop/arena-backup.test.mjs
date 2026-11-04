import assert from "node:assert/strict";
import { createCipheriv, createHash, scryptSync } from "node:crypto";
import { cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createArenaBackup, postmasterState, restoreArenaBackup, verifyArenaBackup } from "./arena-backup.mjs";

const passphrase = "correct horse battery staple";
const legacyScrypt = { N: 32_768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

async function fixture() {
  const parent = await mkdtemp(path.join(tmpdir(), "arena-data-backup-"));
  const root = path.join(parent, "source");
  await mkdir(path.join(root, "data/postgres/base/1"), { recursive: true });
  await mkdir(path.join(root, "runtime"), { recursive: true });
  await writeFile(path.join(root, "data/postgres/PG_VERSION"), "16\n");
  await writeFile(path.join(root, "data/postgres/base/1/record"), "preserved arena record");
  await writeFile(path.join(root, "runtime/db-password.json"), JSON.stringify({ password: "matching-database-password-123" }));
  return { parent, root };
}

async function hashFiles(root) {
  const files = {};
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const relative = path.relative(root, full).split(path.sep).join("/");
      if (entry.isDirectory()) await walk(full);
      else {
        const contents = await readFile(full);
        files[relative] = {
          bytes: contents.length,
          sha256: createHash("sha256").update(contents).digest("hex"),
        };
      }
    }
  }
  await walk(root);
  return files;
}

function legacyCredential(contents) {
  const salt = Buffer.alloc(16, 0x2a);
  const iv = Buffer.alloc(12, 0x31);
  const key = scryptSync(passphrase, salt, 32, legacyScrypt);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(contents), cipher.final()]);
  key.fill(0);
  return Buffer.from(JSON.stringify({
    algorithm: "scrypt+aes-256-gcm",
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  }));
}

test("process state fails closed for malformed or uncheckable PostgreSQL pid", async () => {
  const { parent, root } = await fixture();
  const dataDir = path.join(root, "data/postgres");
  try {
    await writeFile(path.join(dataDir, "postmaster.pid"), "not-a-pid\n");
    assert.throws(() => postmasterState(dataDir), /uncertain/);
    await writeFile(path.join(dataDir, "postmaster.pid"), "4242\n");
    assert.throws(() => postmasterState(dataDir, () => { throw new Error("probe failed"); }), /Could not determine/);
    assert.equal(postmasterState(dataDir, () => false), "stopped");
    assert.equal(postmasterState(dataDir, () => true), "running");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("v2 encrypts the database and credential, verifies all files, and restores to a new root", async () => {
  const { parent, root } = await fixture();
  try {
    await mkdir(path.join(root, "waveyard/storage"), { recursive: true });
    await writeFile(path.join(root, "waveyard/storage/private-original.wav"), "must stay out of database-only backups");
    await assert.rejects(
      createArenaBackup({ root, parentDir: parent, passphrase }),
      /not confirmed a clean database shutdown/,
    );
    const { backupDir, manifest, summary } = await createArenaBackup({
      root,
      parentDir: parent,
      passphrase,
      databaseStopped: true,
      now: () => new Date("2026-10-31T12:00:00.000Z"),
    });
    assert.equal(manifest.version, 2);
    assert.equal(manifest.pgVersion, "16");
    assert.equal(manifest.includesWaveyardFiles, false);
    assert.deepEqual(manifest.waveyardSelection, []);
    assert.match(manifest.scope, /Encrypted PostgreSQL database.*selected local folders/);
    assert.equal(Object.hasOwn(manifest, "summary"), false);
    assert.equal(Object.keys(manifest.files).some((relative) => relative.startsWith("database/") || relative.startsWith("waveyard/")), false);
    assert.equal(Object.keys(manifest.files).every((relative) => relative.startsWith("payload/")), true);
    assert.deepEqual(manifest.localFolders, []);
    assert.equal(summary.localFileCount, 0);
    assert.equal(summary.waveyardFileCount, 0);
    assert.equal(JSON.stringify(manifest).includes("database/PG_VERSION"), false);
    assert.equal(JSON.stringify(manifest).includes("runtime/db-password.json"), false);
    const backupFiles = await Promise.all(Object.keys(manifest.files).map(relative => readFile(path.join(backupDir, relative))));
    assert.equal(backupFiles.some(contents => contents.includes(Buffer.from("matching-database-password-123"))), false);
    assert.equal(backupFiles.some(contents => contents.includes(Buffer.from("preserved arena record"))), false);
    assert.equal(backupFiles.some(contents => contents.includes(Buffer.from("PG_VERSION"))), false);
    const legacyManifest = { ...manifest };
    delete legacyManifest.waveyardSelection;
    await writeFile(path.join(backupDir, "backup-manifest.json"), `${JSON.stringify(legacyManifest, null, 2)}\n`);
    assert.deepEqual((await verifyArenaBackup(backupDir)).mismatches, []);

    const restoredRoot = path.join(parent, "restored");
    await assert.rejects(
      restoreArenaBackup({ backupDir, targetRoot: restoredRoot, passphrase: "a different passphrase" }),
      /incorrect|damaged/,
    );
    await assert.rejects(readFile(path.join(restoredRoot, "data/postgres/PG_VERSION")), { code: "ENOENT" });
    const restored = await restoreArenaBackup({ backupDir, targetRoot: restoredRoot, passphrase });
    assert.equal(restored.pgVersion, "16");
    assert.equal(await readFile(path.join(restoredRoot, "data/postgres/base/1/record"), "utf8"), "preserved arena record");
    assert.deepEqual(
      JSON.parse(await readFile(path.join(restoredRoot, "runtime/db-password.json"), "utf8")),
      { password: "matching-database-password-123" },
    );
    await assert.rejects(
      readFile(path.join(restoredRoot, "waveyard/storage/private-original.wav")),
      { code: "ENOENT" },
    );
    await assert.rejects(
      restoreArenaBackup({ backupDir, targetRoot: restoredRoot, passphrase }),
      /new, empty/,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("optional Waveyard storage and captures are verified and restored without model caches", async () => {
  const { parent, root } = await fixture();
  const audio = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x10, 0x20, 0x30, 0x40]);
  const capture = Buffer.from([0x00, 0x01, 0x02, 0x7f, 0x80, 0xff]);
  const longAudio = Buffer.alloc(2 * 1024 * 1024, 0x5a);
  try {
    await mkdir(path.join(root, "waveyard/storage/library"), { recursive: true });
    await mkdir(path.join(root, "waveyard/capture/session"), { recursive: true });
    await mkdir(path.join(root, "waveyard/models"), { recursive: true });
    await writeFile(path.join(root, "waveyard/storage/library/track.wav"), audio);
    await writeFile(path.join(root, "waveyard/storage/library/long-track.flac"), longAudio);
    await writeFile(path.join(root, "waveyard/capture/session/take.pcm"), capture);
    await writeFile(path.join(root, "waveyard/models/large-model.bin"), "not part of a user-media backup");

    const { backupDir, manifest, summary } = await createArenaBackup({
      root,
      parentDir: parent,
      passphrase,
      databaseStopped: true,
      waveyardSelection: ["storage", "capture"],
      now: () => new Date("2026-11-01T12:00:00.000Z"),
    });
    assert.equal(manifest.includesWaveyardFiles, true);
    assert.deepEqual(manifest.waveyardSelection, ["storage", "capture"]);
    assert.deepEqual(manifest.localFolders, ["waveyard-storage"]);
    assert.match(manifest.scope, /selected local folders \(waveyard-storage\)/);
    assert.equal(summary.waveyardFileCount, 3);
    assert.equal(summary.waveyardBytes, audio.byteLength + longAudio.byteLength + capture.byteLength);
    const serializedManifest = JSON.stringify(manifest);
    assert.equal(serializedManifest.includes("track.wav"), false);
    assert.equal(serializedManifest.includes("take.pcm"), false);
    assert.deepEqual((await verifyArenaBackup(backupDir)).mismatches, []);

    const restoredRoot = path.join(parent, "waveyard-restored");
    const restored = await restoreArenaBackup({ backupDir, targetRoot: restoredRoot, passphrase });
    assert.equal(restored.waveyardFileCount, 3);
    assert.equal(restored.waveyardBytes, audio.byteLength + longAudio.byteLength + capture.byteLength);
    assert.deepEqual(await readFile(path.join(restoredRoot, "waveyard/storage/library/track.wav")), audio);
    assert.deepEqual(await readFile(path.join(restoredRoot, "waveyard/storage/library/long-track.flac")), longAudio);
    assert.deepEqual(await readFile(path.join(restoredRoot, "waveyard/capture/session/take.pcm")), capture);
    await assert.rejects(readFile(path.join(restoredRoot, "waveyard/models/large-model.bin")), { code: "ENOENT" });

    const payloadPath = Object.keys(manifest.files).find(relative => relative !== "payload/index.enc");
    const payloadFile = path.join(backupDir, payloadPath);
    const payload = await readFile(payloadFile);
    payload[0] ^= 0xff;
    await writeFile(payloadFile, payload);
    const tamperedManifest = JSON.parse(await readFile(path.join(backupDir, "backup-manifest.json"), "utf8"));
    tamperedManifest.files[payloadPath].sha256 = createHash("sha256").update(payload).digest("hex");
    await writeFile(path.join(backupDir, "backup-manifest.json"), `${JSON.stringify(tamperedManifest, null, 2)}\n`);
    assert.equal((await verifyArenaBackup(backupDir)).ok, true);
    const tamperedRestore = path.join(parent, "tampered-restore");
    await assert.rejects(
      restoreArenaBackup({ backupDir, targetRoot: tamperedRestore, passphrase }),
      /incorrect|damaged|verification failed/i,
    );
    await assert.rejects(readFile(path.join(tamperedRestore, "data/postgres/PG_VERSION")), { code: "ENOENT" });
    assert.equal((await readdir(parent)).some(entry => entry.startsWith(".arena-restore-")), false);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("Waveyard library and capture selections restore independently", async () => {
  const { parent, root } = await fixture();
  const audio = Buffer.from("selected library audio");
  const capture = Buffer.from("selected capture recording");
  try {
    await mkdir(path.join(root, "waveyard/storage/library"), { recursive: true });
    await mkdir(path.join(root, "waveyard/capture/session"), { recursive: true });
    await mkdir(path.join(root, "waveyard/models"), { recursive: true });
    await writeFile(path.join(root, "waveyard/storage/library/track.wav"), audio);
    await writeFile(path.join(root, "waveyard/capture/session/take.pcm"), capture);
    await writeFile(path.join(root, "waveyard/models/model.onnx"), "never include model caches");

    const cases = [
      {
        selection: ["storage"],
        selectedPath: "waveyard/storage/library/track.wav",
        selectedBytes: audio,
        excludedPath: "waveyard/capture/session/take.pcm",
      },
      {
        selection: ["capture"],
        selectedPath: "waveyard/capture/session/take.pcm",
        selectedBytes: capture,
        excludedPath: "waveyard/storage/library/track.wav",
      },
    ];
    for (const [index, scenario] of cases.entries()) {
      const { backupDir, manifest, summary } = await createArenaBackup({
        root,
        parentDir: parent,
        passphrase,
        databaseStopped: true,
        waveyardSelection: scenario.selection,
        now: () => new Date(Date.UTC(2026, 10, 2, 12, 0, index)),
      });
      assert.deepEqual(manifest.waveyardSelection, scenario.selection);
      assert.equal(manifest.includesWaveyardFiles, true);
      assert.deepEqual(manifest.localFolders, ["waveyard-storage"]);
      assert.equal(summary.waveyardFileCount, 1);
      assert.equal((await verifyArenaBackup(backupDir)).ok, true);

      const target = path.join(parent, `restored-selection-${index}`);
      const restored = await restoreArenaBackup({ backupDir, targetRoot: target, passphrase });
      assert.equal(restored.waveyardFileCount, 1);
      assert.deepEqual(await readFile(path.join(target, scenario.selectedPath)), scenario.selectedBytes);
      await assert.rejects(readFile(path.join(target, scenario.excludedPath)), { code: "ENOENT" });
      await assert.rejects(readFile(path.join(target, "waveyard/models/model.onnx")), { code: "ENOENT" });
      if (index === 0) {
        const manifestPath = path.join(backupDir, "backup-manifest.json");
        const editedManifest = JSON.parse(await readFile(manifestPath, "utf8"));
        editedManifest.waveyardSelection = ["capture"];
        await writeFile(manifestPath, `${JSON.stringify(editedManifest, null, 2)}\n`);
        await assert.rejects(
          restoreArenaBackup({
            backupDir,
            targetRoot: path.join(parent, "mismatched-selection-restore"),
            passphrase,
          }),
          /index does not match its manifest/,
        );
      }
    }
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("legacy v1 backups remain restorable and clearly identifiable", async () => {
  const { parent, root } = await fixture();
  try {
    const originalCredential = await readFile(path.join(root, "runtime/db-password.json"));
    const legacyDir = path.join(parent, "legacy-v1");
    await mkdir(path.join(legacyDir, "database"), { recursive: true });
    await mkdir(path.join(legacyDir, "waveyard/storage/library"), { recursive: true });
    await cp(path.join(root, "data/postgres"), path.join(legacyDir, "database"), { recursive: true });
    await writeFile(path.join(legacyDir, "waveyard/storage/library/old.wav"), Buffer.from([0, 1, 2, 255]));
    await writeFile(path.join(legacyDir, "credential.enc"), legacyCredential(originalCredential));
    const manifest = {
      format: "arena-data-backup",
      version: 1,
      createdAt: "2026-11-01T00:00:00.000Z",
      pgVersion: "16",
      includesWaveyardFiles: true,
      scope: "Legacy v1 backup; database and media are readable.",
      credentialSha256: createHash("sha256").update(originalCredential).digest("hex"),
      files: await hashFiles(legacyDir),
    };
    await writeFile(path.join(legacyDir, "backup-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    assert.equal((await verifyArenaBackup(legacyDir)).ok, true);

    const restoredRoot = path.join(parent, "restored-legacy");
    const restored = await restoreArenaBackup({ backupDir: legacyDir, targetRoot: restoredRoot, passphrase });
    assert.equal(restored.pgVersion, "16");
    assert.equal(restored.waveyardFileCount, 1);
    assert.deepEqual(await readFile(path.join(restoredRoot, "waveyard/storage/library/old.wav")), Buffer.from([0, 1, 2, 255]));
    assert.deepEqual(
      JSON.parse(await readFile(path.join(restoredRoot, "runtime/db-password.json"), "utf8")),
      { password: "matching-database-password-123" },
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("legacy database-only backups restore without Waveyard or optional folders", async () => {
  const { parent, root } = await fixture();
  const legacyDir = path.join(parent, "legacy-database-only-v1");
  try {
    await mkdir(path.join(legacyDir, "database"), { recursive: true });
    await cp(path.join(root, "data/postgres"), path.join(legacyDir, "database"), { recursive: true });
    const credential = await readFile(path.join(root, "runtime/db-password.json"));
    await writeFile(path.join(legacyDir, "credential.enc"), legacyCredential(credential));
    const files = await hashFiles(legacyDir);
    await writeFile(path.join(legacyDir, "backup-manifest.json"), JSON.stringify({
      format: "arena-data-backup",
      version: 1,
      createdAt: "2026-11-02T12:00:00.000Z",
      pgVersion: "16",
      includesWaveyardFiles: false,
      localFolders: [],
      credentialSha256: createHash("sha256").update(credential).digest("hex"),
      files,
    }));

    assert.equal((await verifyArenaBackup(legacyDir)).ok, true);
    const target = path.join(parent, "legacy-database-only-restored");
    const restored = await restoreArenaBackup({ backupDir: legacyDir, targetRoot: target, passphrase });
    assert.equal(restored.pgVersion, "16");
    assert.equal(restored.waveyardFileCount, 0);
    assert.equal(restored.localFileCount, 0);
    assert.equal(await readFile(path.join(target, "data/postgres/base/1/record"), "utf8"), "preserved arena record");
    await assert.rejects(readFile(path.join(target, "waveyard/storage")), { code: "ENOENT" });
    await assert.rejects(readFile(path.join(target, "waveyard/capture")), { code: "ENOENT" });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("selected local folders are verified and restored only under a new data root", async () => {
  const { parent, root } = await fixture();
  const workspace = path.join(root, "data/space-workspaces/project-1");
  try {
    await mkdir(path.join(root, "waveyard/storage/audio"), { recursive: true });
    await mkdir(path.join(root, "waveyard/capture"), { recursive: true });
    await mkdir(path.join(root, "waveyard/models"), { recursive: true });
    await mkdir(path.join(workspace, "browser-profile/Default"), { recursive: true });
    await writeFile(path.join(root, "waveyard/storage/audio/song.wav"), "private audio");
    await writeFile(path.join(root, "waveyard/capture/take.pcm"), "capture data");
    await writeFile(path.join(root, "waveyard/models/model.onnx"), "model weights");
    await writeFile(path.join(workspace, "project.json"), "workspace content");
    await writeFile(path.join(workspace, "browser-profile/Default/Cookies"), "session cookie");

    const { backupDir, manifest, summary } = await createArenaBackup({
      root,
      parentDir: parent,
      passphrase,
      databaseStopped: true,
      localFolders: ["waveyard-storage", "waveyard-models", "workspace-files"],
    });
    assert.deepEqual(manifest.localFolders, ["waveyard-models", "waveyard-storage", "workspace-files"]);
    assert.equal(summary.localFileCount, 4);
    assert.equal(summary.waveyardFileCount, 3);
    assert.equal((await verifyArenaBackup(backupDir)).ok, true);

    const target = path.join(parent, "restored-local");
    const restored = await restoreArenaBackup({ backupDir, targetRoot: target, passphrase });
    assert.equal(restored.localFileCount, 4);
    assert.equal(await readFile(path.join(target, "waveyard/storage/audio/song.wav"), "utf8"), "private audio");
    assert.equal(await readFile(path.join(target, "waveyard/capture/take.pcm"), "utf8"), "capture data");
    assert.equal(await readFile(path.join(target, "waveyard/models/model.onnx"), "utf8"), "model weights");
    assert.equal(await readFile(path.join(target, "data/space-workspaces/project-1/project.json"), "utf8"), "workspace content");
    await assert.rejects(readFile(path.join(target, "data/space-workspaces/project-1/browser-profile/Default/Cookies")), { code: "ENOENT" });
    assert.equal(await readFile(path.join(root, "data/space-workspaces/project-1/browser-profile/Default/Cookies"), "utf8"), "session cookie");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("browser profiles require explicit opt-in and are verified on restore", async () => {
  const { parent, root } = await fixture();
  const profile = path.join(root, "data/space-workspaces/project-2/browser-profile/Default");
  try {
    await mkdir(profile, { recursive: true });
    await writeFile(path.join(profile, "Cookies"), "account session");
    await writeFile(path.join(profile, "History"), "browsing history");
    const { backupDir, manifest, summary } = await createArenaBackup({
      root, parentDir: parent, passphrase, databaseStopped: true, localFolders: ["browser-profiles"],
    });
    assert.deepEqual(manifest.localFolders, ["browser-profiles"]);
    assert.equal(summary.localFileCount, 2);

    const target = path.join(parent, "restored-profile");
    const restored = await restoreArenaBackup({ backupDir, targetRoot: target, passphrase });
    assert.equal(restored.localFileCount, 2);
    assert.equal(await readFile(path.join(target, "data/space-workspaces/project-2/browser-profile/Default/Cookies"), "utf8"), "account session");

    const payloadPath = Object.keys(manifest.files).find(relative => relative !== "payload/index.enc");
    await writeFile(path.join(backupDir, payloadPath), "tampered");
    assert.equal((await verifyArenaBackup(backupDir)).ok, false);
    await assert.rejects(
      restoreArenaBackup({ backupDir, targetRoot: path.join(parent, "tampered-target"), passphrase }),
      /Backup verification failed/,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("backup refuses unsupported scopes and unsafe manifest paths", async () => {
  const { parent, root } = await fixture();
  try {
    await assert.rejects(
      createArenaBackup({ root, parentDir: parent, passphrase, databaseStopped: true, localFolders: ["arbitrary-folder"] }),
      /scope is invalid/,
    );
    await assert.rejects(
      createArenaBackup({ root, parentDir: parent, passphrase, databaseStopped: true, waveyardSelection: ["models"] }),
      /Waveyard backup folders are invalid/,
    );
    await assert.rejects(
      createArenaBackup({
        root,
        parentDir: parent,
        passphrase,
        databaseStopped: true,
        includeWaveyardFiles: false,
        waveyardSelection: ["capture"],
      }),
      /both selected and excluded/,
    );
    const { backupDir } = await createArenaBackup({ root, parentDir: parent, passphrase, databaseStopped: true });
    const manifestPath = path.join(backupDir, "backup-manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.files["payload/../outside.txt"] = { bytes: 0, sha256: "0".repeat(64) };
    await writeFile(manifestPath, JSON.stringify(manifest));
    await assert.rejects(verifyArenaBackup(backupDir), /unsafe path/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("version 1 backups with selected local files restore into a new root", async () => {
  const { parent } = await fixture();
  const backupDir = path.join(parent, "legacy-v1");
  const credential = Buffer.from(JSON.stringify({ password: "legacy-password-123456" }));
  const passphraseBytes = Buffer.from(passphrase);
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(passphraseBytes, salt, 32, { N: 32_768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(credential), cipher.final()]);
  const encryptedCredential = Buffer.from(JSON.stringify({
    algorithm: "scrypt+aes-256-gcm",
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  }));
  const files = {};
  const addFile = async (relative, value) => {
    const contents = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const destination = path.join(backupDir, ...relative.split("/"));
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, contents);
    files[relative] = {
      bytes: contents.length,
      sha256: createHash("sha256").update(contents).digest("hex"),
    };
  };
  try {
    await addFile("database/PG_VERSION", "16\n");
    await addFile("database/base/1/record", "preserved arena record");
    await addFile("credential.enc", encryptedCredential);
    await addFile("waveyard/storage/library/track.wav", "legacy audio");
    await addFile("local/waveyard/models/model.onnx", "legacy model");
    await addFile("local/data/space-workspaces/project-1/project.json", "legacy workspace");
    await writeFile(path.join(backupDir, "backup-manifest.json"), JSON.stringify({
      format: "arena-data-backup",
      version: 1,
      createdAt: "2026-11-01T12:00:00.000Z",
      pgVersion: "16",
      includesWaveyardFiles: true,
      localFolders: ["waveyard-models", "waveyard-storage", "workspace-files"],
      credentialSha256: createHash("sha256").update(credential).digest("hex"),
      files,
    }));

    assert.equal((await verifyArenaBackup(backupDir)).ok, true);
    const target = path.join(parent, "legacy-restored");
    const restored = await restoreArenaBackup({ backupDir, targetRoot: target, passphrase });
    assert.equal(restored.localFileCount, 3);
    assert.equal(restored.waveyardFileCount, 2);
    assert.equal(await readFile(path.join(target, "waveyard/storage/library/track.wav"), "utf8"), "legacy audio");
    assert.equal(await readFile(path.join(target, "waveyard/models/model.onnx"), "utf8"), "legacy model");
    assert.equal(await readFile(path.join(target, "data/space-workspaces/project-1/project.json"), "utf8"), "legacy workspace");
  } finally {
    key.fill(0);
    passphraseBytes.fill(0);
    await rm(parent, { recursive: true, force: true });
  }
});

test("backup rejects a running cluster and detects changed or extra files", async () => {
  const { parent, root } = await fixture();
  try {
    const dataDir = path.join(root, "data/postgres");
    await writeFile(path.join(dataDir, "postmaster.pid"), "4242\n");
    await assert.rejects(
      createArenaBackup({ root, parentDir: parent, passphrase, databaseStopped: true, processExists: () => true }),
      /still running/,
    );
    await writeFile(path.join(dataDir, "postmaster.pid"), "uncertain\n");
    await assert.rejects(
      createArenaBackup({ root, parentDir: parent, passphrase, databaseStopped: true }),
      /uncertain/,
    );
    await rm(path.join(dataDir, "postmaster.pid"));
    const { backupDir, manifest } = await createArenaBackup({
      root,
      parentDir: parent,
      passphrase,
      databaseStopped: true,
    });
    const dataFile = Object.keys((await verifyArenaBackup(backupDir)).manifest.files)
      .find(relative => relative !== "payload/index.enc");
    await writeFile(path.join(backupDir, dataFile), "tampered record");
    assert.equal((await verifyArenaBackup(backupDir)).ok, false);
    await writeFile(path.join(backupDir, "unexpected.txt"), "extra");
    await assert.rejects(
      restoreArenaBackup({ backupDir, targetRoot: path.join(parent, "restore"), passphrase }),
      /Backup verification failed/,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
