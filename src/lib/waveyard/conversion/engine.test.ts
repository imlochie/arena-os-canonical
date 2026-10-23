import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capabilities, convert, formats, inspect, outputName, runTool, settingsSchema, verify } from "./engine";

test("real native encoding/decoding in all six advertised codecs preserves timed stereo and compatible Unicode metadata", async () => {
 const dir=await mkdtemp(join(tmpdir(),"arena-codec-test-"));
 try {
  const source=join(dir,"source.flac");
  await runTool("ffmpeg",["-v","error","-f","lavfi","-i","sine=frequency=440:sample_rate=48000:duration=1.25","-ac","2","-metadata","title=Signal 🎵","-metadata","artist=Artist","-metadata","album=Album","-metadata","track=3/10","-metadata","genre=Test","-metadata","date=2024","-c:a","flac",source]);
  const info=await inspect(source);assert.equal(info.tags.title,"Signal 🎵");assert.equal(info.channels,2);
  const available=await capabilities();assert.equal(available.filter(f=>f.available).length,6);
  for(const format of Object.keys(formats) as Array<keyof typeof formats>){
   const settings=settingsSchema.parse({format}), output=join(dir,`out-${format}.${formats[format].ext}`);
   await convert(source,output,settings,info.tags);const result=await verify(output,info,settings,info.tags);
   assert.equal(result.actual.tags.title,info.tags.title);assert.equal(result.actual.tags.artist,"Artist");assert.equal(result.fullyDecoded,true);assert.equal(result.checksumSha256.length,64);assert.ok(result.fileSizeBytes>1000);
   const pcm=join(dir,`${format}.f32`);await runTool("ffmpeg",["-v","error","-i",output,"-map","0:a:0","-f","f32le","-acodec","pcm_f32le",pcm]);const bytes=await readFile(pcm);let energy=0;for(let i=0;i<bytes.length;i+=4)energy+=bytes.readFloatLE(i)**2;assert.ok(Math.sqrt(energy/(bytes.length/4))>0.03);console.log(JSON.stringify({format,codec:result.actual.codec,duration:result.actual.durationSeconds,channels:result.actual.channels,sampleRate:result.actual.sampleRate,bytes:result.fileSizeBytes,sha256:result.checksumSha256,warnings:result.warnings}));
  }
  const change=settingsSchema.parse({format:"flac",sampleRate:44100,channels:1});await convert(source,join(dir,"changed.flac"),change,info.tags);assert.equal((await verify(join(dir,"changed.flac"),info,change,info.tags)).actual.channels,1);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test("naming and encoder inputs cannot become traversal, absolute host paths, or arbitrary commands",()=>{
 const settings=settingsSchema.parse({format:"flac"});assert.match(outputName(settings,{artist:"../Host",album:"A/B",track:"3/10",title:'🎵 "song"'},"aabbccdd-0000-4000-8000-000000000001"),/^_Host\/A_B\/03 - 🎵 _song_ - aabbccdd.flac$/);
 for(const template of["../outside","/etc/host","C:\\Windows\\out","artist//album","{bad}/title"]){assert.throws(()=>outputName({...settings,template},{},"aabbccdd-0000-4000-8000-000000000001"));}
 assert.equal(settingsSchema.safeParse({format:"mp3; touch bad"}).success,false);assert.equal(settingsSchema.safeParse({format:"mp3",bitrate:999}).success,false);assert.equal(settingsSchema.safeParse({format:"mp3",command:"rm"}).success,false);
});

test("compatible cover artwork and extended tags are retained or explicitly reported per real container",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"arena-tags-test-"));try{
 const cover=join(dir,"cover.png"),source=join(dir,"tagged.flac");await runTool("ffmpeg",["-v","error","-f","lavfi","-i","color=c=blue:s=16x16","-frames:v","1",cover]);await runTool("ffmpeg",["-v","error","-f","lavfi","-i","sine=duration=1.25:sample_rate=48000","-i",cover,"-map","0:a","-map","1:v","-c:a","flac","-c:v","copy","-disposition:v:0","attached_pic","-metadata","title=Artwork","-metadata","album_artist=Album Artist","-metadata","disc=1/2","-metadata","date=2025-03-04","-metadata","lyrics=[00:01.00] Legitimate user lyrics 🎵",source]);const info=await inspect(source);assert.ok(info.artwork);assert.ok(info.tags.lyrics);
 for(const format of Object.keys(formats) as Array<keyof typeof formats>){const settings=settingsSchema.parse({format});const output=join(dir,`art-${format}.${formats[format].ext}`);await convert(source,output,settings,info.tags);const result=await verify(output,info,settings,info.tags);if(!["wav","aiff"].includes(format))assert.ok(result.actual.artwork,format);else assert.ok(result.warnings.some(s=>s.includes("artwork")));for(const [field,value] of Object.entries(info.tags))if(result.actual.tags[field as keyof typeof info.tags]!==value)assert.ok(result.warnings.some(w=>w.endsWith(`: ${field}`)));}
 }finally{await rm(dir,{recursive:true,force:true});}
});

test("preserve surround layout by default; explicit CD-ready PCM and lossy-source limitations are verified, additional tag loss is visible",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"arena-layout-test-"));try{const source=join(dir,"surround.flac");await runTool("ffmpeg",["-v","error","-f","lavfi","-i","sine=duration=1.25:sample_rate=48000","-af","pan=5.1|FL=c0|FR=c0|FC=c0|LFE=c0|BL=c0|BR=c0","-metadata","composer=Café composer","-metadata","mandate_unknown=Retain or warn","-c:a","flac",source]);const info=await inspect(source);assert.equal(info.channels,6);assert.equal(info.channelLayout,"5.1");assert.equal(info.unreviewedTags.mandate_unknown,"Retain or warn");const unchanged=settingsSchema.parse({format:"flac"}),out=join(dir,"unchanged.flac");await convert(source,out,unchanged,info.tags);const kept=await verify(out,info,unchanged,info.tags);assert.equal(kept.actual.channelLayout,"5.1");assert.equal(kept.actual.unreviewedTags.mandate_unknown,"Retain or warn");const cd=settingsSchema.parse({format:"wav",pcmBits:16,sampleRate:44100,channels:2}),wav=join(dir,"cd-ready-not-burned.wav");await convert(source,wav,cd,info.tags);const pcm=await verify(wav,info,cd,info.tags);assert.equal(pcm.actual.codec,"pcm_s16le");assert.equal(pcm.actual.bitsPerSample,16);assert.equal(pcm.actual.sampleRate,44100);assert.equal(pcm.actual.channelLayout,"stereo");assert.ok(pcm.warnings.some(w=>w.includes("mandate_unknown")));const mp3=join(dir,"lossy.mp3"),lossy=settingsSchema.parse({format:"mp3",channels:2});await convert(source,mp3,lossy,info.tags);const lossyInfo=await inspect(mp3),lossless=settingsSchema.parse({format:"flac"}),restored=join(dir,"not-restored.flac");await convert(mp3,restored,lossless,lossyInfo.tags);assert.ok((await verify(restored,lossyInfo,lossless,lossyInfo.tags)).warnings.some(w=>w.includes("cannot restore")));}finally{await rm(dir,{recursive:true,force:true});}
});

test("disguised HLS/concat programs are not local audio intake and cannot open a remote URL or another local file",async()=>{
 const {writeFile}=await import("node:fs/promises"),{createServer}=await import("node:http"),{probeAudio}=await import("../audio");const dir=await mkdtemp(join(tmpdir(),"arena-audio-boundary-"));let requests=0;const server=createServer((_req,res)=>{requests++;res.writeHead(403).end();});await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));try{const port=(server.address() as{port:number}).port;const playlist=join(dir,"not-a-wave.wav");await writeFile(playlist,`#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:10,\nhttp://127.0.0.1:${port}/never-open.aac\n#EXT-X-ENDLIST\n`);for(const probe of[inspect,probeAudio])await assert.rejects(()=>probe(playlist),/whitelist|invalid data/i);const standardHls=join(dir,"not-audio.m3u8");await writeFile(standardHls,await readFile(playlist));for(const probe of[inspect,probeAudio])await assert.rejects(()=>probe(standardHls),/whitelist/i);assert.equal(requests,0);const hidden=join(dir,"unselected.flac");await runTool("ffmpeg",["-v","error","-f","lavfi","-i","sine=duration=1",hidden]);await writeFile(playlist,"ffconcat version 1.0\nfile unselected.flac\n");for(const probe of[inspect,probeAudio])await assert.rejects(()=>probe(playlist),/whitelist/i);}finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));await rm(dir,{recursive:true,force:true});}
});

test("oversized embedded metadata is explicitly warned before/after bounded review, never called exact preservation",async(t)=>{
 // The fixture hands a 70,000-character value to ffmpeg on its command line.
 // Windows caps a command line at 32,767 characters and the spawn fails with
 // ENAMETOOLONG before ffmpeg runs, so the fixture — not the product — cannot
 // exist there. Skipped with that reason (never reported as a pass); the
 // 64,000 bound itself is product code and is verified on POSIX.
 if (process.platform === "win32") { t.skip("Windows command line is limited to 32,767 characters; a 70,000-character metadata value cannot be passed to ffmpeg"); return; }
 const dir=await mkdtemp(join(tmpdir(),"arena-long-tags-"));try{const source=join(dir,"source.flac"),output=join(dir,"bounded.flac"),longTitle="L".repeat(70000);await runTool("ffmpeg",["-v","error","-f","lavfi","-i","sine=duration=1","-metadata",`title=${longTitle}`,"-c:a","flac",source]);const info=await inspect(source);assert.equal(info.tags.title?.length,64000);assert.deepEqual(info.truncatedTags,["title"]);const settings=settingsSchema.parse({format:"flac"});await convert(source,output,settings,info.tags);const result=await verify(output,info,settings,info.tags);assert.equal(result.fullyDecoded,true);assert.ok(result.warnings.some(w=>w.includes("64,000-character review limit: title")));assert.deepEqual((await inspect(source)).truncatedTags,["title"]);}finally{await rm(dir,{recursive:true,force:true});}
});
