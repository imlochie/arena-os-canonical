import { getArenaRoom } from "@workspace/arena/lib/arenaRooms";
import { getArchiveBridgeStatus } from "@workspace/arena/lib/archive-assistant/bridge-status";
export async function loadPage(params: Record<string,string>) {
  const { roomId } = await params;
  const room = getArenaRoom(roomId);
  if (!room) return Response.json({ error: "Not found" }, { status: 404 });

  // The Archive Assistant room carries a live, server-side connection probe:
  // the bridge client is server-only, so the status must be resolved here and
  // passed down as plain data.
  const bridgeStatus =
    room.id === "archive-assistant" ? await getArchiveBridgeStatus() : null;

  return Response.json({ room, bridgeStatus });
}
