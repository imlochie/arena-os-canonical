// Real PG/private objects/HTTP recovery; controlled code replies are contract
// fixtures, NOT genuine provider reasoning or novel-game quality acceptance.
import test,{before,after} from "node:test"; import assert from "node:assert/strict"; import {randomUUID} from "node:crypto"; import {mkdtemp,rm} from "node:fs/promises"; import {tmpdir} from "node:os"; import path from "node:path";
import {eq} from "drizzle-orm"; import {missionPostgres} from "../helpers/mission-postgres.ts";
let f,pool,db,schema,attempts,forge,games,route,root;
const owner="00000000-0000-4000-8000-000000000001";
before(async()=>{f=await missionPostgres();process.env.DATABASE_URL=f.url;root=await mkdtemp(path.join(tmpdir(),"arena-attempts-"));process.env.WAVEYARD_STORAGE_DIR=root;({db,pool}=await import("../../src/db/index.ts"));schema=await import("../../src/db/schema.ts");attempts=await import("../../src/lib/games/attempts.ts");forge=await import("../../src/lib/games/forge-ai.ts");games=await import("../../src/lib/games/index.ts");route=await import("../../src/app/api/arcade/attempts/route.ts");});
after(async()=>{await pool?.end();await f?.close();if(root)await rm(root,{recursive:true,force:true});});
const response=(text)=>({text,modelId:"CONTROLLED-FIXTURE-NOT-INFERENCE",backend:"groq",runtimeLevel:"remote",via:"controlled-contract-fixture",ms:1,fallback:false});
async function operation(prompt="Novel fixture mechanics",id=randomUUID()){return(await attempts.beginAttempt(owner,id,prompt)).cursor;}
async function checkpoint(cursor,code){return attempts.checkpointAttempt(cursor,{state:games.validateGameCode(code).ok?"validated":"draft"},{code,validation:games.validateGameCode(code),runtime:{modelId:"CONTROLLED-FIXTURE",backend:"fixture",ms:1}});}
async function request(body){return route.POST(new Request("http://localhost/api/arcade/attempts",{method:"POST",headers:{host:"localhost","content-type":"application/json"},body:JSON.stringify(body)}));}

test("stable owner-bound attempt retries never create a second generation identity; distinct request reuse is rejected",async()=>{
 const id=randomUUID();const [a,b]=await Promise.all([attempts.beginAttempt(owner,id,"same request"),attempts.beginAttempt(owner,id,"same request")]);assert.equal(Number(a.created)+Number(b.created),1);assert.equal(a.cursor.id,b.cursor.id);
 await assert.rejects(()=>attempts.beginAttempt(owner,id,"different request"),/different work/);await assert.rejects(()=>attempts.getAttempt("foreign",id),/unavailable/);
 const row=(await db.select().from(schema.arcadeGames));assert.equal(row.length,0);
});

test("useful failed partial is durably checkpointed before repair; repair outage + PG restart preserve exact Unicode bytes, never a playable game",async()=>{
 let cursor=await operation();const useful='<!DOCTYPE html><html><canvas id="game"></canvas><script>// Useful unfinished ghost-camera mechanics 🎵\nconst exposure=0.25;';let calls=0;
 await assert.rejects(()=>forge.forgeGameWithAI(cursor.value.prompt,{onDraft:async draft=>{cursor=await attempts.checkpointAttempt(cursor,{state:"draft"},draft);}},{generate:async()=>{if(++calls>1)throw new Error("controlled repair outage");return response(useful);}}),/Repair model unavailable/);
 cursor=await attempts.checkpointAttempt(cursor,{state:"failed",error:"controlled repair outage"});await f.stop();await f.start();const reopened=await attempts.getAttempt(owner,cursor.id);assert.equal(await attempts.attemptCode(reopened),useful);assert.equal(reopened.value.state,"failed");assert.equal((await db.select().from(schema.arcadeGames)).length,0);
 const download=await route.GET(new Request(`http://localhost/api/arcade/attempts?id=${cursor.id}&download=1`,{headers:{host:"localhost"}}));assert.equal(download.status,200);assert.equal(await download.text(),useful);
 const cleanup=await import("../../src/lib/artifact-reclamation.ts");assert.equal((await cleanup.reportReclamation(owner,reopened.value.draftObject.sha256)).mayMark,false);
});

test("cancellation commits before late model output; revision fencing prevents both draft replacement and game publication",async()=>{
 let cursor=await operation();const valid=games.generateGameOffline("snake").code;cursor=await checkpoint(cursor,valid);const old=cursor;
 assert.equal((await request({id:cursor.id,action:"cancel"})).status,200);
 await assert.rejects(()=>attempts.checkpointAttempt(old,{state:"validated"},{code:valid,validation:games.validateGameCode(valid),runtime:{modelId:"fixture",ms:1}}),/changed\/cancelled/);
 await assert.rejects(()=>attempts.finishAttempt(old,valid,"snake"),/changed\/cancelled/);assert.equal((await db.select().from(schema.arcadeGames)).length,0);assert.equal((await attempts.getAttempt(owner,cursor.id)).value.state,"cancelled");
});

test("game insert + attempt completion roll back together; exact validated bytes can be saved via recovery API after restart with no inference replay",async()=>{
 let cursor=await operation();const code=games.generateGameOffline("snake with wrap").code;cursor=await checkpoint(cursor,code);
 await pool.query("CREATE FUNCTION reject_attempt_completion() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.source_type='arcade-generation' AND NEW.body::jsonb->>'state'='completed' THEN RAISE EXCEPTION 'controlled completion outage'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_attempt_completion BEFORE UPDATE ON artifacts FOR EACH ROW EXECUTE FUNCTION reject_attempt_completion()");
 try{assert.equal((await request({id:cursor.id,action:"save"})).status,503);assert.equal((await db.select().from(schema.arcadeGames)).length,0);}finally{await pool.query("DROP TRIGGER reject_attempt_completion ON artifacts;DROP FUNCTION reject_attempt_completion()");}
 await f.stop();await f.start();const saved=await request({id:cursor.id,action:"save"});assert.equal(saved.status,200);const body=await saved.json();assert.equal(body.game.code,code);assert.equal(body.attempt.value.state,"completed");
 const again=await request({id:cursor.id,action:"save"});assert.equal(again.status,200);assert.equal((await db.select().from(schema.arcadeGames)).length,1);
 const [game]=await db.select().from(schema.arcadeGames).where(eq(schema.arcadeGames.id,body.game.id));assert.equal(game.code,code);assert.equal((await request({id:cursor.id,action:"cancel"})).status,409);
});

test("concurrent save acknowledgements identify one exact game, never duplicate catalogue entries",async()=>{
 let cursor=await operation("Concurrent exact save");const code=games.generateGameOffline("pong hard").code;cursor=await checkpoint(cursor,code);const count=(await db.select().from(schema.arcadeGames)).length;
 const responses=await Promise.all([request({id:cursor.id,action:"save"}),request({id:cursor.id,action:"save"})]);assert.deepEqual(responses.map(r=>r.status),[200,200]);const bodies=await Promise.all(responses.map(r=>r.json()));assert.equal(bodies[0].game.id,bodies[1].game.id);assert.equal(bodies[0].game.code,code);assert.equal((await db.select().from(schema.arcadeGames)).length,count+1);
});
