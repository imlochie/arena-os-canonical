import { notFound } from "next/navigation";
import ArenaRoomDetail from "@/components/ArenaRoomDetail";
import { getArenaRoom } from "@/lib/arenaRooms";

export default async function RoomDetailPage({
  params,
}: {
  params: Promise<{ roomId: string }>;
}) {
  const { roomId } = await params;
  const room = getArenaRoom(roomId);
  if (!room) notFound();

  return (
    <main className="min-h-[100dvh] bg-arena">
      <ArenaRoomDetail room={room} />
    </main>
  );
}