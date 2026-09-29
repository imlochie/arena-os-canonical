import Link from "next/link";
import {
  ARENA_DISCOVERY_ROOMS,
  ARENA_NAVIGATION_ROOMS,
  roomTitle,
} from "@/lib/arena-rooms";

export function ArenaRoomsDirectory() {
  return (
    <section className="arena-rooms-page" aria-labelledby="arena-rooms-title" data-testid="arena-rooms-directory">
      <header className="arena-rooms-hero">
        <p className="arena-rooms-kicker">Arena discovery</p>
        <h1 id="arena-rooms-title">Find the right room before work moves.</h1>
        <p>
          This is a discovery taxonomy for the most common ways to begin in Arena OS.
          It complements the complete shell navigation rather than replacing it. Opening a room
          never starts a model, job, upload, export, or handoff.
        </p>
        <div className="arena-rooms-summary" aria-label="Room directory summary">
          <span>{ARENA_DISCOVERY_ROOMS.length} discovery rooms</span>
          <span>{ARENA_NAVIGATION_ROOMS.length} verified navigation surfaces</span>
          <Link href="/handoffs">Review local drafts →</Link>
        </div>
      </header>

      <div className="arena-rooms-heading">
        <div>
          <p className="arena-rooms-kicker">Room taxonomy</p>
          <h2>Choose a working context</h2>
        </div>
        <p>Planning concepts remain visible, but are not executable destinations.</p>
      </div>

      <div className="arena-room-grid">
        {ARENA_DISCOVERY_ROOMS.map((room) => {
          const operational = room.availability === "operational";
          return (
            <Link
              key={room.id}
              href={`/rooms/${room.id}`}
              className="arena-room-card"
              data-testid={`arena-room-card-${room.id}`}
            >
              <div className="arena-room-card-top">
                <span className="arena-room-emoji" aria-hidden>{room.emoji}</span>
                <span className={`arena-room-state ${operational ? "operational" : "planning"}`}>
                  {operational ? "Verified surface" : "Planning only"}
                </span>
              </div>
              <p className="arena-rooms-kicker">{room.label}</p>
              <h3>{roomTitle(room)}</h3>
              <p>{room.description}</p>
              <span className="arena-room-card-action">
                {operational ? "Review room →" : "Review planning note →"}
              </span>
            </Link>
          );
        })}
      </div>
    </section>
  );
}
