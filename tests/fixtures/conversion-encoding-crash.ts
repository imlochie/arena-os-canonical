/** Stop a REAL ffmpeg encoder after spawn, so the parent can kill/restart it. */
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
const original=childProcess.spawn;
childProcess.spawn=((...args: Parameters<typeof original>)=>{
  const child=original(...args);
  if(Array.isArray(args[1])&&args[1].includes("-fs"))child.once("spawn",()=>{child.kill("SIGSTOP");process.send?.({event:"encoding-started",pid:child.pid,output:args[1]?.at(-1)});});
  return child;
}) as typeof original;
syncBuiltinESMExports();
const{execute}=await import("../../src/lib/waveyard/conversion/jobs");await execute(process.argv[2]);
