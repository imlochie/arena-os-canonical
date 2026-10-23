/** Browser client contract only, not a model acquisition/inference proof. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareStemEngine } from './client';
test('model preparation client refuses unreviewed acquisition without any request',async()=>{
 const old=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;return Response.json({});};
 try{assert.equal((await prepareStemEngine('stems_4')).ok,false);assert.equal(calls,0);}finally{globalThis.fetch=old;}
});
test('reviewed preparation forwards deliberate permission and cancellation to existing recipe route',async()=>{
 const old=globalThis.fetch,controller=new AbortController();
 globalThis.fetch=async(url,init)=>{assert.equal(url,'/api/waveyard/separation/models/stems_4/seed');assert.equal(init?.signal,controller.signal);assert.deepEqual(JSON.parse(String(init?.body)),{rightsReviewed:true});return Response.json({requeued:2});};
 try{assert.deepEqual(await prepareStemEngine('stems_4',controller.signal,true),{ok:true,requeued:2});}finally{globalThis.fetch=old;}
});
test('cancelled preparation never reports success and explains retained/resumable files',async()=>{
 const old=globalThis.fetch,controller=new AbortController();controller.abort();
 globalThis.fetch=async()=>{controller.signal.throwIfAborted();return Response.json({});};
 try{const result=await prepareStemEngine('stems_4',controller.signal,true);assert.equal(result.ok,false);assert.match(!result.ok?result.error:'',/cancelled.*resumable/i);}finally{globalThis.fetch=old;}
});
