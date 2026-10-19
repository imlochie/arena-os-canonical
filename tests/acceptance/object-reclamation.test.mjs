// Real PostgreSQL + real local private bytes. No fake deletion provider.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, readFile, writeFile, utimes, stat, readdir } from "node:fs/promises";
import path from "node:path"; import { tmpdir } from "node:os";
import { eq } from "drizzle-orm";
import { missionPostgres } from "../helpers/mission-postgres.ts";
let f, db, pool, schema, objects, service, store, storage, root;
const owner = "00000000-0000-4000-8000-000000000001";
before(async () => {
  f = await missionPostgres(); process.env.DATABASE_URL = f.url;
  root = await mkdtemp(path.join(tmpdir(), "arena-reclamation-")); process.env.WAVEYARD_STORAGE_DIR = root;
  ({ db, pool } = await import("../../src/db/index.ts")); schema = await import("../../src/db/schema.ts");
  objects = await import("../../src/lib/artifact-objects.ts"); service = await import("../../src/lib/artifact-reclamation.ts"); store = await import("../../src/lib/arcadeStore.ts");
  storage = (await import("../../src/lib/waveyard/storage.ts")).getStorage();
});
after(async () => { delete process.env.ARENA_ENABLE_OBJECT_RECLAMATION; await pool?.end(); await f?.close(); if (root) await rm(root, { recursive: true, force: true }); });
async function oldObject(text = randomUUID()) {
  const bytes = Buffer.from(`USEFUL PRIVATE WORK 🎵 ${text}`), object = await objects.writeArtifactObject(owner, bytes);
  const filename = storage.getLocalPath(objects.artifactObjectKey(owner, object));
  const past = new Date(Date.now() - 100 * 86400000); await utimes(filename, past, past); return { bytes, object, filename };
}
async function mark(item) { return service.markReclamation(owner, item.object.sha256, randomUUID(), true); }
async function elapse(id, purge = false) { await pool.query(`UPDATE object_reclamations SET ${purge ? "quarantined_at=now()-interval '8 days', purge_after" : "marked_at=now()-interval '8 days', not_before"}=now()-interval '1 second' WHERE id=$1`, [id]); }
async function bind(item, sourceType = "manual") { return store.insertArtifact(db, { ownerId: owner, title: "Retained work", body: objects.artifactObjectSummary(item.object), contentObject: item.object, kind: "archive", sourceType }); }

test("default dry-run changes no bytes/mtime/ledger; fresh, partial and corrupt objects are not candidates", async () => {
  const item = await oldObject(), before = await stat(item.filename); const count = (await service.listReclamations(owner)).length;
  const report = await service.reportReclamation(owner, item.object.sha256); assert.equal(report.mayMark, true); assert.equal(report.policy.enabled, false);
  assert.deepEqual(await readFile(item.filename), item.bytes); assert.equal((await stat(item.filename)).mtimeMs, before.mtimeMs); assert.equal((await service.listReclamations(owner)).length, count);
  await assert.rejects(() => service.markReclamation(owner, item.object.sha256, randomUUID(), false), /abandonment/);
  const marked = await mark(item); await assert.rejects(() => service.sweepReclamation(owner, marked.id, true), /disabled/);
  assert.equal((await service.sweepReclamation(owner, marked.id)).dryRun, true);
  const fresh = await objects.writeArtifactObject(owner, "fresh publication"); assert.equal((await service.reportReclamation(owner, fresh.sha256)).mayMark, false);
  await writeFile(item.filename + `.${randomUUID()}.partial`, "interrupted upload"); assert.equal((await service.reportReclamation(owner, item.object.sha256)).mayMark, false);
  const corrupt = await oldObject(); await writeFile(corrupt.filename, "corrupt"); await assert.rejects(() => service.reportReclamation(owner, corrupt.object.sha256), /checksum|identity|corrupt/i);
});

test("current legacy, immutable history, tombstones beyond retention, mission/archive and deduplicated roots never become reclaimable", async () => {
  for (const kind of ["legacy", "history", "mission-output", "orchestrator", "deduplicated"]) {
    const item = await oldObject(kind);
    if (kind === "legacy") await db.insert(schema.artifacts).values({ ownerId: owner, title: "Missing baseline", body: objects.artifactObjectSummary(item.object), contentObject: item.object });
    else {
      const artifact = await bind(item, kind);
      if (kind === "history") { await store.updateArtifact(db, artifact.id, owner, { body: "New current content" }, 1); await store.deleteArtifact(db, artifact.id, owner); await pool.query("UPDATE artifacts SET deleted_at=now()-interval '400 days' WHERE id=$1", [artifact.id]); }
      if (kind === "deduplicated") await bind(item);
    }
    assert.equal((await service.reportReclamation(owner, item.object.sha256)).mayMark, false);
    assert.equal((await mark(item)).state, "refused"); assert.deepEqual(await readFile(item.filename), item.bytes);
  }
  // Establish the missing legacy baseline using the existing history operation
  // so unrelated cleanup tests are not blocked by deliberately uncertain roots.
  const legacy = (await db.select().from(schema.artifacts)).find(row => row.title === "Missing baseline"); await store.listArtifactRevisions(db, legacy.id, owner);
});

test("stale candidate is refused after reference creation, and grace cannot be bypassed by ordinary execute", async () => {
  process.env.ARENA_ENABLE_OBJECT_RECLAMATION = "1";
  const item = await oldObject(), candidate = await mark(item); assert.equal(candidate.state, "marked");
  await assert.rejects(() => service.sweepReclamation(owner, candidate.id, true), /grace/);
  const artifact = await bind(item); await elapse(candidate.id);
  const refused = await service.sweepReclamation(owner, candidate.id, true); assert.equal(refused.state, "refused"); assert.match(refused.reason, /reference/);
  assert.deepEqual(await objects.readArtifactObject(owner, artifact.contentObject), item.bytes);
});

test("mark survives restart; quarantine is recoverable and duplicate cleanup is idempotent", async () => {
  const item = await oldObject(), candidate = await mark(item); await elapse(candidate.id); await f.stop(); await f.start();
  const [a,b] = await Promise.all([service.sweepReclamation(owner, candidate.id, true), service.sweepReclamation(owner, candidate.id, true)]);
  assert.equal(a.state, "quarantined"); assert.equal(b.state, "quarantined");
  await assert.rejects(() => service.sweepReclamation(owner, candidate.id, true, true), /recovery period/);
  const restored = await service.restoreReclamation(owner, candidate.id); assert.equal(restored.state, "restored"); assert.deepEqual(await readFile(item.filename), item.bytes);
  await assert.rejects(() => service.restoreReclamation("foreign", candidate.id), /unavailable/);
});

test("real unlink followed by SQL failure retains durable intent; restart reconciles without repeated deletion", async () => {
  const item = await oldObject(), candidate = await mark(item); await elapse(candidate.id); await service.sweepReclamation(owner, candidate.id, true); await elapse(candidate.id, true);
  await pool.query("CREATE FUNCTION reject_reclaim_completion() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.state='reclaimed' THEN RAISE EXCEPTION 'fault after physical unlink'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_reclaim_completion BEFORE UPDATE ON object_reclamations FOR EACH ROW EXECUTE FUNCTION reject_reclaim_completion()");
  try { await assert.rejects(() => service.sweepReclamation(owner, candidate.id, true, true)); } finally { await pool.query("DROP TRIGGER reject_reclaim_completion ON object_reclamations; DROP FUNCTION reject_reclaim_completion()"); }
  const [intent] = await db.select().from(schema.objectReclamations).where(eq(schema.objectReclamations.id, candidate.id)); assert.equal(intent.state, "purging");
  await assert.rejects(() => readFile(item.filename), { code: "ENOENT" }); assert.equal((await readdir(path.dirname(item.filename))).some(name => name.includes(candidate.id)), false);
  await f.stop(); await f.start(); const done = await service.sweepReclamation(owner, candidate.id, true, true); assert.equal(done.state, "reclaimed");
  assert.equal((await service.sweepReclamation(owner, candidate.id, true, true)).state, "reclaimed");
  await assert.rejects(() => bind(item), error => /reclamation unresolved/.test(error.cause?.message ?? error.message));
  await objects.writeArtifactObject(owner, item.bytes); const recovered = await bind(item); assert.deepEqual(await objects.readArtifactObject(owner, recovered.contentObject), item.bytes);
});

test("uncommitted reference creation serializes with sweep; newly committed root wins, never the stale candidate", async () => {
  const item = await oldObject(), candidate = await mark(item); await elapse(candidate.id);
  const writer = await pool.connect();
  try {
    await writer.query("BEGIN");
    const { rows: [row] } = await writer.query("INSERT INTO artifacts (owner_id,title,body,content_object) VALUES ($1,'Concurrent root',$2,$3) RETURNING id", [owner, objects.artifactObjectSummary(item.object), JSON.stringify(item.object)]);
    const sweep = service.sweepReclamation(owner, candidate.id, true);
    assert.equal(await Promise.race([sweep.then(() => "finished"), new Promise(resolve => setTimeout(() => resolve("waiting"), 100))]), "waiting");
    await writer.query("COMMIT"); const result = await sweep;
    assert.equal(result.state, "refused"); assert.deepEqual(await readFile(item.filename), item.bytes);
    await store.listArtifactRevisions(db, row.id, owner);
  } finally { await writer.query("ROLLBACK"); writer.release(); }
});

test("SQL failure after physical quarantine is repaired by restart + restore, with exact owner-only download", async () => {
  const item = await oldObject(), candidate = await mark(item); await elapse(candidate.id);
  await pool.query("CREATE FUNCTION reject_quarantine_completion() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.state='quarantined' THEN RAISE EXCEPTION 'fault after physical rename'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_quarantine_completion BEFORE UPDATE ON object_reclamations FOR EACH ROW EXECUTE FUNCTION reject_quarantine_completion()");
  try { await assert.rejects(() => service.sweepReclamation(owner, candidate.id, true)); } finally { await pool.query("DROP TRIGGER reject_quarantine_completion ON object_reclamations; DROP FUNCTION reject_quarantine_completion()"); }
  const [intent] = await db.select().from(schema.objectReclamations).where(eq(schema.objectReclamations.id, candidate.id)); assert.equal(intent.state, "quarantining");
  assert.deepEqual(Buffer.from(await (await service.downloadReclamation(owner, candidate.id)).arrayBuffer()), item.bytes);
  await assert.rejects(() => service.downloadReclamation("foreign", candidate.id), /unavailable/);
  await f.stop(); await f.start(); const result = await service.sweepReclamation(owner, candidate.id, true); assert.equal(result.state, "restored"); assert.deepEqual(await readFile(item.filename), item.bytes);
});

test("publication refresh supersedes a stale mark, failed metadata publication leaves recoverable bytes, and missing safety guards fail closed", async () => {
  const item = await oldObject(), candidate = await mark(item); await elapse(candidate.id);
  await objects.writeArtifactObject(owner, item.bytes);
  assert.equal((await service.sweepReclamation(owner, candidate.id, true)).state, "superseded"); assert.deepEqual(await readFile(item.filename), item.bytes);
  const orphan = await oldObject(); await pool.query("CREATE FUNCTION reject_orphan_binding() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.title='Retained work' THEN RAISE EXCEPTION 'publication failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_orphan_binding BEFORE INSERT ON artifacts FOR EACH ROW EXECUTE FUNCTION reject_orphan_binding()");
  try { await assert.rejects(() => bind(orphan)); assert.deepEqual(await readFile(orphan.filename), orphan.bytes); } finally { await pool.query("DROP TRIGGER reject_orphan_binding ON artifacts; DROP FUNCTION reject_orphan_binding()"); }
  await pool.query("ALTER TABLE artifacts DISABLE TRIGGER guard_reclaimed_artifact");
  try { await assert.rejects(() => mark(orphan), /safety guards missing/); } finally { await pool.query("ALTER TABLE artifacts ENABLE TRIGGER guard_reclaimed_artifact"); }
});

test("real Library cleanup controls mark, enforce grace, quarantine, download exact bytes, restore after PG restart and expose the durable audit", async () => {
  const { build } = await import("esbuild"), { createServer } = await import("node:http"), { chromium } = await import("playwright-core"), { expect } = await import("@playwright/test");
  const route = await import("../../src/app/api/artifacts/storage/route.ts");
  const bundle = await build({ stdin: { contents: 'import React from "react"; import {createRoot} from "react-dom/client"; import {ArtifactStorageRecovery} from "./src/components/artifacts/ArtifactStorageRecovery"; createRoot(document.getElementById("root")).render(<ArtifactStorageRecovery onChange={async()=>{}}/>);', loader: "tsx", resolveDir: process.cwd() }, bundle: true, write: false, platform: "browser", format: "esm", jsx: "automatic" });
  const server = createServer(async (req,res) => {
    try {
      if (req.url === "/fixture.js") { res.setHeader("content-type", "text/javascript"); return res.end(bundle.outputFiles[0].contents); }
      if (req.url.startsWith("/api/")) {
        let body=""; for await(const chunk of req) body+=chunk;
        const request = new Request(`http://localhost${req.url}`, { method:req.method, headers:{host:"localhost","content-type":"application/json"},...(req.method==="POST"?{body}:{}) });
        const response = await route[req.method](request); res.writeHead(response.status,Object.fromEntries(response.headers)); return res.end(Buffer.from(await response.arrayBuffer()));
      }
      res.setHeader("content-type","text/html"); res.end('<div id="root"></div><script type="module" src="/fixture.js"></script>');
    } catch { res.writeHead(503); res.end('Unavailable'); }
  });
  await new Promise(resolve=>server.listen(0,"0.0.0.0",resolve)); const browser = await chromium.launch({executablePath:process.env.CHROMIUM_EXECUTABLE_PATH || undefined,headless:true,args:["--no-sandbox","--disable-dev-shm-usage"]});
  try {
    const item=await oldObject(), page=await browser.newPage(); await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.getByRole("button",{name:"Inspect retained private content",exact:true}).click();
    const row=page.getByText(item.object.sha256,{exact:true}).locator(".."); await row.getByRole("button",{name:"Dry-run cleanup eligibility",exact:true}).click(); await expect(row).toContainText("No current blockers");
    page.once("dialog",dialog=>dialog.accept()); const marked=page.waitForResponse(response=>response.request().method()==="POST"&&response.request().postDataJSON().action==="mark"); await row.getByRole("button",{name:"Mark abandoned bytes (no deletion)",exact:true}).click(); const {operation}=await(await marked).json();
    const audit=page.getByRole("article",{name:`Cleanup ${operation.id}`,exact:true}); await expect(audit).toContainText("marked");
    page.once("dialog",dialog=>dialog.accept()); await audit.getByRole("button",{name:"Quarantine abandoned bytes",exact:true}).click(); await expect(page.getByRole("status")).toContainText("grace period has not elapsed");
    await elapse(operation.id); page.once("dialog",dialog=>dialog.accept()); await audit.getByRole("button",{name:"Quarantine abandoned bytes",exact:true}).click(); await expect(audit).toContainText("quarantined");
    const transfer=page.waitForEvent("download"); await audit.getByRole("link",{name:"Download retained quarantine",exact:true}).click(); assert.deepEqual(await readFile(await(await transfer).path()),item.bytes);
    await f.stop(); await f.start(); await page.reload(); await page.getByRole("button",{name:"Inspect retained private content",exact:true}).click(); await expect(audit).toContainText("quarantined");
    await audit.getByRole("button",{name:"Restore retained bytes",exact:true}).click(); await expect(audit).toContainText("restored"); assert.deepEqual(await readFile(item.filename),item.bytes);
    await audit.getByText("Inspect cleanup audit",{exact:true}).click(); await expect(audit).toContainText("Owner restored retained bytes");
  } finally { await browser.close(); await new Promise(resolve=>server.close(resolve)); }
});

test("actual Studio version and source storage-key roots, including a future room table, protect exact bytes", async () => {
  const item=await oldObject(), version=await oldObject(), future=await oldObject();
  const wy=await import("../../src/db/waveyardSchema.ts");
  const [project]=await db.insert(wy.projects).values({ownerId:owner,title:"Reference roots"}).returning();
  await db.insert(wy.sourceAssets).values({projectId:project.id,originalFilename:"private.bin",mimeType:"application/octet-stream",storageKey:objects.artifactObjectKey(owner,item.object),checksumSha256:item.object.sha256,durationSeconds:1,sampleRate:44100,channels:1,codec:"pcm",fileSizeBytes:item.bytes.length});
  const [session]=await db.insert(wy.remixSessions).values({projectId:project.id,ownerId:owner,name:"Retained version"}).returning();
  await db.insert(wy.remixVersions).values({createdById:owner,remixSessionId:session.id,name:"Snapshot",snapshot:JSON.stringify({contentObject:version.object})});
  await pool.query("CREATE TABLE future_room_reference (snapshot jsonb)");
  try {
    await pool.query("INSERT INTO future_room_reference VALUES ($1)",[JSON.stringify({contentObject:future.object})]);
    for(const kept of [item,version,future]) { const report=await service.reportReclamation(owner,kept.object.sha256); assert.equal(report.mayMark,false); assert.match(report.reasons.join(";"),/source_assets|remix_versions|future_room_reference/); assert.deepEqual(await readFile(kept.filename),kept.bytes); }
  } finally { await pool.query("DROP TABLE future_room_reference"); }
});

test("a started quarantine download remains exact during a separately confirmed purge", async () => {
  const item=await oldObject(), candidate=await mark(item); await elapse(candidate.id); await service.sweepReclamation(owner,candidate.id,true); await elapse(candidate.id,true);
  const response=await service.downloadReclamation(owner,candidate.id);
  assert.equal((await service.sweepReclamation(owner,candidate.id,true,true)).state,"reclaimed");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()),item.bytes);
});

test("symlinked owner directories and hardlinked files are uncertain, never someone else's orphan", async () => {
  const {mkdir,symlink,link,unlink}=await import("node:fs/promises"); const item=await oldObject(), foreign="00000000-0000-4000-8000-000000000003";
  const foreignPath=storage.getLocalPath(objects.artifactObjectKey(foreign,item.object)); await mkdir(path.dirname(path.dirname(foreignPath)),{recursive:true}); await symlink(path.dirname(item.filename),path.dirname(foreignPath),"dir");
  try { await assert.rejects(()=>service.reportReclamation(foreign,item.object.sha256),/Symlinked/); assert.deepEqual(await readFile(item.filename),item.bytes); } finally { await unlink(path.dirname(foreignPath)); }
  await link(item.filename,item.filename+".hardlink"); try { await assert.rejects(()=>mark(item),/single regular private file/); } finally { await unlink(item.filename+".hardlink"); }
});

test("an owner disagreement in historical metadata prevents absence certification, even for another unbound checksum", async () => {
  const original=await oldObject(), candidate=await oldObject(); const artifact=await bind(original); const revision=artifact.currentRevisionId;
  await pool.query("UPDATE artifact_revisions SET snapshot=jsonb_set(snapshot,'{ownerId}','\"unknown-owner\"') WHERE id=$1",[revision]);
  try { const report=await service.reportReclamation(owner,candidate.object.sha256); assert.equal(report.mayMark,false); assert.match(report.reasons.join(";"),/Unresolved/); assert.equal((await mark(candidate)).state,"refused"); assert.deepEqual(await readFile(candidate.filename),candidate.bytes); }
  finally { await pool.query("UPDATE artifact_revisions SET snapshot=jsonb_set(snapshot,'{ownerId}',to_jsonb($2::text)) WHERE id=$1",[revision,owner]); }
});
