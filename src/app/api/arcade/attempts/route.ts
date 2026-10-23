import { AttemptError, attemptCode, cancelAttempt, getAttempt, listAttempts, finishAttempt, completedAttemptGame } from "@/lib/games/attempts";
import { requireApiAccess } from "@/lib/security/api-access";
import { requireUser } from "@/lib/waveyard/local-context";
export const dynamic="force-dynamic";
const headers={"cache-control":"private, no-store"};
function failure(error:unknown) { return Response.json({error:error instanceof AttemptError?error.message:"Attempt storage unavailable. No acknowledgement; inspect retained work and retry after services recover."},{status:error instanceof AttemptError?error.status:503}); }
export async function GET(req:Request) {
  const denied=await requireApiAccess(req); if(denied)return denied;
  try { const user=await requireUser(), id=new URL(req.url).searchParams.get("id"); if(!id)return Response.json({attempts:await listAttempts(user.id)},{headers});
    const cursor=await getAttempt(user.id,id), code=await attemptCode(cursor); if(new URL(req.url).searchParams.has("download"))return new Response(code,{headers:{"content-type":"text/plain; charset=utf-8","content-disposition":`attachment; filename="arcade-attempt-${id}.txt"`,"cache-control":"private, no-store"}}); return Response.json({attempt:cursor,code},{headers});
  } catch(error) { return failure(error); }
}
export async function POST(req:Request) {
  const denied=await requireApiAccess(req); if(denied)return denied;
  try { const user=await requireUser(), body=await req.json();
    if(body.action==="cancel")return Response.json({attempt:await cancelAttempt(user.id,String(body.id??""))});
    if(body.action==="save") { const cursor=await getAttempt(user.id,String(body.id??"")); if(cursor.value.state==="completed")return Response.json({attempt:cursor,game:await completedAttemptGame(cursor)}); const game=await finishAttempt(cursor,await attemptCode(cursor),"custom");return Response.json({game,attempt:await getAttempt(user.id,cursor.id)}); }
    throw new AttemptError("Unknown attempt action.",400);
  }catch(error){return failure(error);}
}
