import Link from "next/link";
import {
  Archive,
  ArrowUpRight,
  BookOpen,
  Bot,
  Boxes,
  Cable,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Compass,
  Cpu,
  Headphones,
  Image,
  LayoutGrid,
  LockKeyhole,
  Network,
  Radio,
  Scale,
  Scissors,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import {
  ARENA_ROOMS,
  ARENA_ROOM_STATE_LABELS,
  type ArenaRoomState,
} from "@/lib/arenaRooms";

const ROOM_ICONS: Record<string, LucideIcon> = {
  assistant: Bot,
  orchestrator: Network,
  council: Scale,
  congress: Compass,
  spaces: Boxes,
  "archive-assistant": Archive,
  classroom: BookOpen,
  studio: Sparkles,
  "cut-lab": Scissors,
  waveyard: Headphones,
  luma: Image,
  "device-security": LockKeyhole,
};

const STATE_STYLES: Record<
  ArenaRoomState,
  { icon: LucideIcon; className: string; dot: string }
> = {
  available: {
    icon: CheckCircle2,
    className: "border-emerald-400/20 bg-emerald-400/10 text-emerald-200",
    dot: "bg-emerald-300",
  },
  local: {
    icon: CircleAlert,
    className: "border-slate-400/20 bg-slate-400/10 text-slate-300",
    dot: "bg-slate-300",
  },
  approval: {
    icon: LockKeyhole,
    className: "border-amber-300/20 bg-amber-300/10 text-amber-100",
    dot: "bg-amber-300",
  },
};

function StateBadge({ state }: { state: ArenaRoomState }) {
  const style = STATE_STYLES[state];
  const Icon = style.icon;

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.12em] ${style.className}`}
    >
      <Icon size={12} strokeWidth={2.2} aria-hidden="true" />
      {ARENA_ROOM_STATE_LABELS[state]}
    </span>
  );
}

export default function ArenaRoomsDirectory() {
  return (
    <section
      className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 sm:py-12"
      data-testid="arena-rooms-directory"
    >
      <div className="relative overflow-hidden rounded-[28px] border border-violet-300/15 bg-[linear-gradient(135deg,rgba(31,24,70,0.88),rgba(10,18,39,0.86)_58%,rgba(8,33,51,0.9))] p-6 shadow-[0_24px_90px_rgba(11,8,38,0.38)] sm:p-10">
        <div className="pointer-events-none absolute -right-20 -top-24 h-64 w-64 rounded-full bg-cyan-300/10 blur-3xl" />
        <div className="pointer-events-none absolute bottom-[-8rem] left-1/3 h-72 w-72 rounded-full bg-violet-500/15 blur-3xl" />
        <div className="relative max-w-3xl">
          <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.2em] text-cyan-200/80">
            <Radio size={14} aria-hidden="true" />
            Arena room index
          </div>
          <h1 className="mt-4 text-3xl font-black tracking-[-0.04em] text-white sm:text-5xl">
            A clear place to begin.
          </h1>
          <p className="mt-4 max-w-2xl text-sm leading-6 text-slate-300 sm:text-base">
            Rooms are addresses into the tools already in Arena OS. Choose a surface,
            review where it leads, and decide when anything should move.
          </p>
          <div className="mt-7 flex flex-wrap items-center gap-3 text-xs font-semibold text-slate-300">
            <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-black/15 px-3 py-2">
              <LayoutGrid size={14} className="text-violet-200" aria-hidden="true" />
              {ARENA_ROOMS.length} distinct rooms
            </span>
            <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-black/15 px-3 py-2">
              <Cable size={14} className="text-cyan-200" aria-hidden="true" />
              Transfers stay visible
            </span>
          </div>
        </div>
      </div>

      <div className="mt-8 flex items-end justify-between gap-4">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-violet-200/70">
            Room directory
          </p>
          <h2 className="mt-2 text-xl font-extrabold tracking-tight text-white">
            Pick a working surface
          </h2>
        </div>
        <Link
          href="/handoffs"
          className="hidden items-center gap-1.5 text-xs font-bold text-cyan-200 transition hover:text-white sm:inline-flex"
          data-testid="rooms-handoffs-link"
        >
          View handoffs
          <ArrowUpRight size={14} aria-hidden="true" />
        </Link>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {ARENA_ROOMS.map((room, index) => {
          const Icon = ROOM_ICONS[room.id] ?? Cpu;
          const isAnchor = index === 0;

          return (
            <Link
              key={room.id}
              // Cards open the room's real working surface directly. Rooms
              // without a destination (none today) fall back to their detail
              // page, which is honestly address-and-handoff only.
              href={room.destination?.href ?? `/rooms/${room.id}`}
              className={`glass card-hover group rounded-2xl p-5 ${
                isAnchor ? "sm:col-span-2 lg:col-span-1 lg:row-span-2 lg:p-6" : ""
              }`}
              data-testid={`room-card-${room.id}`}
            >
              <div className="flex items-start justify-between gap-3">
                <span className="grid h-11 w-11 place-items-center rounded-2xl border border-violet-300/15 bg-violet-400/10 text-violet-200 transition group-hover:border-cyan-200/25 group-hover:bg-cyan-300/10 group-hover:text-cyan-100">
                  <Icon size={21} strokeWidth={1.8} aria-hidden="true" />
                </span>
                <ChevronRight
                  size={17}
                  className="text-slate-500 transition group-hover:translate-x-0.5 group-hover:text-cyan-200"
                  aria-hidden="true"
                />
              </div>
              <p className="mt-5 text-[10px] font-bold uppercase tracking-[0.18em] text-violet-200/70">
                {room.eyebrow}
              </p>
              <h3 className="mt-1 text-lg font-extrabold tracking-tight text-white">
                {room.name}
              </h3>
              <p className="mt-2 min-h-[3.5rem] text-sm leading-5 text-slate-400">
                {room.description}
              </p>
              <div className="mt-5 flex flex-wrap items-center gap-2">
                <StateBadge state={room.state} />
                {room.destination ? (
                  <span className="text-[10px] font-semibold text-slate-500">
                    {room.destination.label}
                  </span>
                ) : (
                  <span className="text-[10px] font-semibold text-slate-500">
                    Address only
                  </span>
                )}
              </div>
            </Link>
          );
        })}
      </div>
    </section>
  );
}