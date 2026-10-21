import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { eq } from 'drizzle-orm';
import { missionPostgres } from '../../../../tests/helpers/mission-postgres';
const pg = await missionPostgres(), root = await mkdtemp(join(tmpdir(), 'arena-server-source-identity-'));
process.env.DATABASE_URL = pg.url; process.env.LOCAL_STORAGE_PATH = join(root, 'objects'); process.env.STORAGE_PROVIDER = 'local';
const schema = await import('../../../packages/database/src/index');
const storage = (await import('../../../packages/storage/src/index')).getStorage();
const { processExport } = await import('../src/export');
const { encodeWav16 } = await import('../../../../src/lib/waveyard/mixer/synth');
const db = schema.getDb(), hash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
try {
  const [project] = await db.insert(schema.projects).values({ ownerId: randomUUID(), title: 'Controlled source integrity, not inference' }).returning();
  const wav = Buffer.from(encodeWav16(Float32Array.from({length:88200},(_,i)=>Math.sin(i*.04)*.2),44100)), file = join(root,'source.wav'); await writeFile(file,wav);
  const key=`projects/${project.id}/source/${randomUUID()}.wav`; await storage.putFile(key,file,'audio/wav');
  const [source] = await db.insert(schema.sourceAssets).values({ projectId: project.id, originalFilename:'controlled.wav', mimeType:'audio/wav',storageKey:key,checksumSha256:hash(wav),durationSeconds:1,sampleRate:44100,channels:2,codec:'pcm_s16le',fileSizeBytes:wav.length }).returning();
  const [separation] = await db.insert(schema.processingJobs).values({ projectId:project.id,sourceAssetId:source.id,type:'separation',model:'none',requestedDevice:'cpu',status:'failed',idempotencyKey:randomUUID() }).returning();
  const [stem] = await db.insert(schema.stemAssets).values({ projectId:project.id,sourceAssetId:source.id,separationJobId:separation.id,stemType:'source',engine:'passthrough-unseparated',model:'none',modelVersion:'0',storageKey:key,checksumSha256:source.checksumSha256,durationSeconds:1,sampleRate:44100,channels:2,codec:'pcm_s16le',format:'wav',fileSizeBytes:wav.length }).returning();
  await db.insert(schema.sourceAnalyses).values({projectId:project.id,sourceAssetId:source.id,status:'complete',stage:'complete',idempotencyKey:randomUUID(),analysisEngine:'controlled-fixture',analysisEngineVersion:'1',sourceChecksumSha256:source.checksumSha256,bpm:120});
  const ffmpeg = process.env.SOURCE_IDENTITY_TEST_FFMPEG;
  assert.ok(ffmpeg, 'native tool path must be supplied by acceptance harness');
  const decode = (filename: string) => execFileSync(ffmpeg, ['-v','error','-i',filename,'-f','f32le','-acodec','pcm_f32le','-'], {maxBuffer:4*1024*1024});
  const reference = decode(file), published: {storageKey:string; checksumSha256:string}[] = [];

  const [session] = await db.insert(schema.remixSessions).values({projectId:project.id,ownerId:project.ownerId,name:'Source identity fault'}).returning();
  const [version] = await db.insert(schema.remixVersions).values({remixSessionId:session.id,createdById:project.ownerId,name:'Source identity fault',snapshot:JSON.stringify({masterVolume:1,tempoBpm:120,targetKey:null,tracks:[{id:randomUUID(),stemAssetId:stem.id,sortOrder:0,volume:1,pan:0,muted:false,solo:false,clips:[{stemAssetId:stem.id,timelineStartMs:0,durationMs:1000,sourceOffsetMs:0,gain:1,fadeInMs:0,fadeOutMs:0}]}],automation:[]})}).returning();
  const copy = storage.getToFile.bind(storage);
  for (const fault of ['stored-bytes', 'copied-bytes', 'copy-unavailable']) {
    const [job] = await db.insert(schema.exportJobs).values({projectId:project.id,remixSessionId:session.id,remixVersionId:version.id,requestedById:project.ownerId,idempotencyKey:randomUUID(),format:'wav'}).returning();
    const payload={exportJobId:job.id,projectId:project.id,remixSessionId:session.id,remixVersionId:version.id,format:'wav' as const};
    const changed=Buffer.from(wav);changed[100]^=1;
    if (fault === 'stored-bytes') await writeFile(storage.getLocalPath(key)!,changed);
    else storage.getToFile = async (...args: Parameters<typeof copy>) => {
      await copy(...args);
      if (args[0] === key) {
        if (fault === 'copy-unavailable') await rm(args[1]);
        else await writeFile(args[1],changed);
      }
    };
    try {
      await assert.rejects(processExport(payload,async()=>{}), /identity could not be verified/i);
      const [done]=await db.select().from(schema.exportJobs).where(eq(schema.exportJobs.id,job.id));
      const assets=await db.select().from(schema.exportAssets).where(eq(schema.exportAssets.exportJobId,job.id));
      assert.equal(done.status,'failed'); assert.equal(done.errorCode,'source_identity_unverified'); assert.equal(assets.length,0);
      const [untouched] = await db.select().from(schema.stemAssets).where(eq(schema.stemAssets.id,stem.id));
      assert.equal(untouched.checksumSha256,hash(wav));
      console.log(JSON.stringify({scope:'Actual standalone PostgreSQL/storage/native FFmpeg; not inference',fault,originalSha256:hash(wav),changedSha256:hash(changed),status:done.status,assets:assets.length,errorCode:done.errorCode}));
    } finally { storage.getToFile=copy; await writeFile(storage.getLocalPath(key)!,wav); }
    // A repaired source can fulfill the SAME frozen request; prior outputs survive.
    await processExport(payload,async()=>{});
    const [recovered]=await db.select().from(schema.exportJobs).where(eq(schema.exportJobs.id,job.id));
    assert.equal(recovered.status,'complete');
    const [asset]=await db.select().from(schema.exportAssets).where(eq(schema.exportAssets.exportJobId,job.id));
    const output=join(root,`recovered-${fault}.wav`); await storage.getToFile(asset.storageKey,output);
    const bytes=await readFile(output); assert.equal(bytes.subarray(0,4).toString(),'RIFF'); assert.equal(hash(bytes),asset.checksumSha256);
    // Studio's existing legacy stereo balance law uses sqrt(0.5) at
    // centre (also asserted by the live audition acceptance). Do not
    // silently change that audible contract in a source-integrity fix.
    const decoded = decode(output); assert.equal(decoded.length,reference.length);
    let maxError=0, energy=0;
    for (let i=0;i<decoded.length;i+=4) { const value=decoded.readFloatLE(i); maxError=Math.max(maxError,Math.abs(value-reference.readFloatLE(i)*Math.SQRT1_2)); energy+=value*value; }
    assert.ok(energy>1,'repaired export is not silent'); assert.ok(maxError<=2/32768,`source fidelity max PCM error ${maxError}`);
    published.push(asset);
    // Subsequent source faults must not destroy earlier committed media.
    for (const prior of published) { await storage.getToFile(prior.storageKey,output); assert.equal(hash(await readFile(output)),prior.checksumSha256); }
    console.log(JSON.stringify({fault,repaired:true,exportSha256:hash(bytes),bytes:bytes.length,maxPcmError:maxError,reference:"source PCM times existing Studio sqrt(0.5) centre pan"}));
  }

} finally {await schema.getPool().end();await pg.close();await rm(root,{recursive:true,force:true});}
