import { realpath, readFile, readdir, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
export type ToolCapability = "filesystem.list"|"filesystem.read"|"filesystem.search"|"git.status"|"git.diff"|"git.log";
export interface ToolGrant { id:string; sessionId:string; resourceId:string; root:string; capabilities:ToolCapability[] }
export interface ToolRequest { sessionId:string; actorId:string; capability:ToolCapability; resourceId:string; path?:string; query?:string; limit?:number }
export interface ToolResult { requestedCapability:ToolCapability; selectedAdapter:"local_filesystem"|"local_git"; resourceId:string; data:unknown; truncated:boolean }
const MAX_BYTES=100_000, MAX_ITEMS=200;

export async function invokeReadOnlyTool(request:ToolRequest, grant:ToolGrant):Promise<ToolResult>{
  if(request.sessionId!==grant.sessionId||request.resourceId!==grant.resourceId||!grant.capabilities.includes(request.capability)) throw new Error("TOOL_SCOPE_DENIED");
  const root=await realpath(grant.root); const target=await authorizePath(root,request.path??".");
  const limit=Math.min(Math.max(request.limit??MAX_ITEMS,1),MAX_ITEMS);
  if(request.capability==="filesystem.read"){
    const info=await stat(target); if(!info.isFile()) throw new Error("TOOL_OBJECT_TYPE_DENIED");
    const b=await readFile(target); return result(request,"local_filesystem",b.subarray(0,MAX_BYTES).toString("utf8"),b.length>MAX_BYTES);
  }
  if(request.capability==="filesystem.list"){
    const names=(await readdir(target)).slice(0,limit); return result(request,"local_filesystem",names,(await readdir(target)).length>limit);
  }
  if(request.capability==="filesystem.search"){
    const q=request.query?.toLowerCase(); if(!q) throw new Error("TOOL_INPUT_INVALID");
    const found:string[]=[]; await walk(target,root,q,found,limit); return result(request,"local_filesystem",found,found.length>=limit);
  }
  const args=request.capability==="git.status"?["status","--short"]:request.capability==="git.diff"?["diff","--",request.path??"."]:["log",`-${limit}`,"--oneline"];
  const {stdout}=await exec("git",args,{cwd:root,maxBuffer:MAX_BYTES}); return result(request,"local_git",stdout.slice(0,MAX_BYTES),stdout.length>MAX_BYTES);
}
async function authorizePath(root:string,path:string){const candidate=await realpath(resolve(root,path));const rel=relative(root,candidate);if(rel.startsWith(".."+sep)||rel===".."||resolve(candidate)===candidate&&rel.startsWith(".."))throw new Error("TOOL_SCOPE_DENIED");return candidate}
async function walk(dir:string,root:string,q:string,out:string[],limit:number){if(out.length>=limit)return;for(const e of await readdir(dir,{withFileTypes:true})){if(out.length>=limit)return;const p=await authorizePath(root,relative(root,resolve(dir,e.name)));if(e.isDirectory())await walk(p,root,q,out,limit);else if(e.isFile()&&e.name.toLowerCase().includes(q))out.push(relative(root,p));}}
function result(r:ToolRequest,a:ToolResult["selectedAdapter"],data:unknown,truncated:boolean):ToolResult{return{requestedCapability:r.capability,selectedAdapter:a,resourceId:r.resourceId,data,truncated}}
