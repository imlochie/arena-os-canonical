import { notFound } from "next/navigation";
import { ArenaRoomDetail } from "@/components/arena/ArenaRoomDetail";
import { getArenaRoom } from "@/lib/arena-rooms";

export default async function RoomPage({ params }: { params: Promise<{ roomId: string }> }) {
  const { roomId } = await params;
  const room = getArenaRoom(roomId);
  if (!room) notFound();
  return <ArenaRoomDetail room={room} />;
}
