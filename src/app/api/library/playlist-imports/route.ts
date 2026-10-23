import { z } from "zod";
import { and, eq, desc, isNull } from "drizzle-orm";
import { db } from "@/db";
import { artifacts } from "@/db/schema";
import { tracks, sourceAssets, playlists, playlistItems } from "@/db/waveyardSchema";
import { requireUser } from "@/lib/waveyard/local-context";
import { requireApiAccess } from "@/lib/security/api-access";
import { insertArtifact, type StoreDb } from "@/lib/arcadeStore";
import { writeArtifactObject, artifactObjectSummary } from "@/lib/artifact-objects";
import { assertPrivateMedia } from "@/lib/waveyard/conversion/private-media";
import { verifyStoredFile } from "../../../../../waveyard-worker/packages/dsp/src/verified-file";
import { getStorage } from "@/lib/waveyard/storage";
import { parsePlaylist, matchEntry } from "@/lib/waveyard/conversion/playlist";
export const runtime="nodejs";
const schema=z.object({action:z.enum(["preview","import"]),name:z.string().trim().min(1).max(160),format:z.enum(["tsv","m3u"]),text:z.string().max(2*1024*1024),requestId:z.string().uuid().optional(),choices:z.record(z.string().regex(/^\d+$/),z.string().uuid().nullable()).default({})});
export async function GET(request:Request){const denied=await requireApiAccess(request);if(denied)return denied;try{const owner=(await requireUser()).id;const imports=await db.select({id:artifacts.id,title:artifacts.title,playlistId:artifacts.sourceId}).from(artifacts).where(and(eq(artifacts.ownerId,owner),eq(artifacts.sourceType,"music-playlist-import"),isNull(artifacts.deletedAt))).orderBy(desc(artifacts.createdAt)).limit(100);return Response.json({imports});}catch{return Response.json({error:"Playlist import history unavailable; retained manifests unchanged."},{status:503});}}
export async function POST(request:Request){const denied=await requireApiAccess(request);if(denied)return denied;
 try{const reader=request.body?.getReader();const chunks=[];let bytes=0;if(reader)for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.length;if(bytes>4*1024*1024){await reader.cancel();return Response.json({error:"Playlist request too large."},{status:413});}chunks.push(Buffer.from(part.value));}const input=schema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8"))),owner=(await requireUser()).id;
 const inventory=await db.select({id:tracks.id,title:tracks.title,artist:tracks.artist,album:tracks.album,durationSeconds:tracks.durationSeconds,originalFilename:sourceAssets.originalFilename,source:sourceAssets}).from(tracks).innerJoin(sourceAssets,eq(tracks.sourceAssetId,sourceAssets.id)).where(eq(tracks.ownerId,owner));
 const entries=parsePlaylist(input.text,input.format);const matches=entries.map(entry=>matchEntry(entry,inventory));
 if(input.action==="preview")return Response.json({matches,scope:"User-provided playlist metadata, not authenticated Apple Music access or streaming export. Ambiguous/unmatched entries are not local audio."});
 if(!input.requestId)throw new Error("Stable request UUID required to import a playlist.");
 const resolved: Array<{ entry: ReturnType<typeof parsePlaylist>[number]; state: string; trackId?: string; sourceAssetId?: string; checksumSha256?: string; candidates?: Array<{id:string;title:string;artist:string;album:string}>; note?:string }> = [];const verified=new Set<string>();for(const match of matches){const selected=input.choices[String(match.entry.index)]===null?undefined:input.choices[String(match.entry.index)]??match.automaticTrackId;
  if(selected&&!match.candidates.some(c=>c.id===selected))throw new Error(`Entry ${match.entry.index+1}: selection is not an owned candidate; no substitution allowed.`);
  if(selected){const local=inventory.find(t=>t.id===selected)!;if(!verified.has(selected)){await assertPrivateMedia(getStorage(),local.source.storageKey);await verifyStoredFile(getStorage(),local.source);verified.add(selected);}resolved.push({entry:match.entry,state:"verified-local",trackId:selected,sourceAssetId:local.source.id,checksumSha256:local.source.checksumSha256});}
  else resolved.push({entry:match.entry,state:match.candidates.length?"unresolved-ambiguous":"reference-only",candidates:match.candidates.map(c=>({id:c.id,title:c.title,artist:c.artist,album:c.album})),note:"No audio acquired. Review/match local files before use in a session."});
 }
 const manifest={version:1,kind:"user-playlist-import",name:input.name,format:input.format,originalExport:input.text,entries:resolved,scope:"User-supplied metadata; references are not downloadable audio. Local subset preserves original relative order."};const object=await writeArtifactObject(owner,JSON.stringify(manifest),"application/json; charset=utf-8");
 await db.transaction(async tx=>{const[previous]=await tx.select().from(artifacts).where(eq(artifacts.id,input.requestId!));if(previous){if(previous.ownerId!==owner||previous.sourceType!=="music-playlist-import"||previous.contentObject?.sha256!==object.sha256)throw new Error("Playlist import identity conflict. Reuse original intent or create a new request.");return;}
  await tx.insert(playlists).values({id:input.requestId,name:input.name,ownerId:owner});const local=resolved.filter(r=>r.trackId);if(local.length)await tx.insert(playlistItems).values(local.map((r,index)=>({playlistId:input.requestId!,trackId:r.trackId!,position:index})));
  await insertArtifact(tx as unknown as StoreDb,{id:input.requestId,ownerId:owner,kind:"research",title:`Music playlist import: ${input.name}`,body:artifactObjectSummary(object),contentObject:object,sourceType:"music-playlist-import",sourceId:input.requestId});
 });return Response.json({playlistId:input.requestId,artifactId:input.requestId,entries:resolved,matched:verified.size,unresolved:resolved.filter(r=>!("trackId" in r)).length},{status:201});
 }catch(error){return Response.json({error:error instanceof Error?error.message:"Playlist import failed; no audio claimed."},{status:422});}
}
