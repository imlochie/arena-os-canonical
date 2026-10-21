/** User-provided playlist metadata only. Never dereference locations/URLs. */
export type PlaylistEntry = { index: number; title: string; artist: string; album: string; durationSeconds?: number; trackNumber?: string; catalogId?: string; location?: string };
export type LocalCandidate = { id: string; title: string; artist: string; album: string; durationSeconds: number; originalFilename: string };
const normal = (s: string) => s.normalize("NFKC").toLocaleLowerCase("en").replace(/\s+/g," ").trim();
export function parsePlaylist(text: string, format: "tsv" | "m3u") {
 if (Buffer.byteLength(text,"utf8")>2*1024*1024 || text.includes("\0")) throw new Error("Playlist must be decoded text, at most2MiB; no binary or protected audio accepted here.");
 const entries: PlaylistEntry[]=[];const lines=text.replace(/^\uFEFF/,"").split(/\r?\n/).filter(line=>line.trim());
 if(format==="tsv"){
  const headers=lines.shift()?.split("\t").map(s=>normal(s).replace(/[ _-]/g,""))??[];
  if(!headers.includes("name")&&!headers.includes("title"))throw new Error("Expected an Apple Music/iTunes-style tab-delimited export with Name or Title headers. XML is not implemented.");
  for(const line of lines){const values=line.split("\t"),row=Object.fromEntries(headers.map((h,i)=>[h,values[i]??""]));const ms=Number(row.totaltime);entries.push({index:entries.length,title:(row.name||row.title||"").slice(0,1000),artist:(row.artist||"").slice(0,1000),album:(row.album||"").slice(0,1000),...(row.totaltime&&Number.isFinite(ms)&&ms>0?{durationSeconds:ms/1000}:{}),trackNumber:row.tracknumber||undefined,catalogId:row.persistentid||row.trackid||undefined,location:row.location?.slice(0,4096)});}
 }else{
  let pending:{duration?:number;title:string;artist:string}|undefined;
  for(const line of lines){if(line.startsWith("#EXTINF:")){const comma=line.indexOf(","),duration=Number(line.slice(8,comma)),label=line.slice(comma+1),parts=label.split(" - ");pending={duration:duration>0?duration:undefined,title:parts.length>1?parts.slice(1).join(" - "):label,artist:parts.length>1?parts[0]:""};}
   else if(!line.startsWith("#")){let name=line.split(/[\\/]/).at(-1)??line;try{name=decodeURIComponent(name);}catch{/* retain literal metadata */}entries.push({index:entries.length,title:pending?.title||name.replace(/\.[^.]+$/,""),artist:pending?.artist||"",album:"",durationSeconds:pending?.duration,location:line.slice(0,4096)});pending=undefined;}}
 }
 if(!entries.length||entries.length>1000)throw new Error("Playlist must contain1–1000 entries.");
 return entries;
}
export function matchEntry(entry: PlaylistEntry, library: LocalCandidate[]) {
 const candidates=library.filter(track=>normal(track.title)===normal(entry.title)&&(!entry.artist||normal(track.artist)===normal(entry.artist))&&(!entry.album||normal(track.album)===normal(entry.album))&&(!entry.durationSeconds||Math.abs(track.durationSeconds-entry.durationSeconds)<=2));
 // Filename/path/stream identifiers alone never certify an audio match.
 const auto = candidates.length===1 && !!entry.artist ? candidates[0].id : undefined;
 return {entry,candidates:candidates.slice(0,50),automaticTrackId:auto,state:auto?"metadata-match":candidates.length?"ambiguous":"unmatched-reference",note:"Metadata match, not an audio fingerprint. Export locations are never read or downloaded."};
}
