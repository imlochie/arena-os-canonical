import { notFound } from "next/navigation";
import ArenaRoomDetail from "@/components/ArenaRoomDetail";
import ArchiveAssistantBridge from "@/components/ArchiveAssistantBridge";
import { getArenaRoom } from "@/lib/arenaRooms";
import { getArchiveBridgeStatus } from "@/lib/archive-assistant/bridge-status";

export default async function RoomDetailPage({
  params,
}: {
  params: Promise<{ roomId: string }>;
}) {
  const { roomId } = await params;
  const room = getArenaRoom(roomId);
  if (!room) notFound();

  // The Archive Assistant room carries a live, server-side connection probe:
  // the bridge client is server-only, so the status must be resolved here and
  // passed down as plain data.
  const bridgeStatus =
    room.id === "archive-assistant" ? await getArchiveBridgeStatus() : null;

  return (
    <main className="min-h-[100dvh] bg-arena">
      <ArenaRoomDetail room={room}>
        {bridgeStatus ? (
          <ArchiveAssistantBridge status={bridgeStatus} />
        ) : null}
      </ArenaRoomDetail>
    </main>
  );
}