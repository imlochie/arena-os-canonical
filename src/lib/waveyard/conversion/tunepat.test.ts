import test from "node:test";
import assert from "node:assert/strict";
import { launchTunePat, tunePatCandidate, tunePatStatus, validateTunePatPath } from "./tunepat";
test("external TunePat path is installation-specific, never a command, script, directory or network executable",()=>{
 assert.equal(validateTunePatPath(tunePatCandidate),tunePatCandidate);
 for(const path of["tunepat","/bin/sh","C:\\Program Files\\TunePat\\","C:\\tmp\\..\\TunePat Apple Music Converter.exe","\\\\server\\share\\TunePat Apple Music Converter.exe","C:\\tmp\\evil.cmd",'C:\\tmp\\TunePat Apple Music Converter.exe" --capture'])assert.throws(()=>validateTunePatPath(path));
});
test("this non-Windows host reports unavailable and refuses actual TunePat launch; no test double is external-app acceptance",async()=>{
 if(process.platform==='win32'){const missing='C:\\Arena-Definitely-Missing-TunePat\\TunePat Apple Music Converter.exe';assert.equal((await tunePatStatus(missing)).available,false);await assert.rejects(()=>launchTunePat(missing));}
 else {assert.equal((await tunePatStatus(tunePatCandidate)).state,'unsupported-platform');await assert.rejects(()=>launchTunePat(tunePatCandidate),/cannot be launched/);}
});
