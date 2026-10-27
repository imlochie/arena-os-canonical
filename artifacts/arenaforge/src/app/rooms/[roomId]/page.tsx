import ArenaRoomDetail from "@/components/ArenaRoomDetail";
import ArchiveAssistantBridge from "@/components/ArchiveAssistantBridge";
import { usePageData } from "@/routing/page-data";
export default function RoomDetailPage({ params }: { params: Record<string,string> }) {
  const state = usePageData("rooms", Object.values(params)[0]);
  if (state.loading) return <p className="text-center text-slate-400">Loading…</p>;
  if (state.error) return <p role="alert" className="text-center text-slate-400">{state.error}</p>;
  const { room, bridgeStatus } = state.data;

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
