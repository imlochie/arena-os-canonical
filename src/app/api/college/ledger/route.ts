import * as ledger from "@/lib/college/ledger";
import { brisbaneToday } from "@/lib/college/time";
import { db } from "@/db";
import { collegeNotifications } from "@/db/college";
import { desc } from "drizzle-orm";

export const dynamic = "force-dynamic";

/**
 * The College Event Ledger — the institutional timeline.
 *
 *   ?date=YYYY-MM-DD    one day, in order (default: today)
 *   ?from=&to=          a range, for the audit
 *   ?sessionId=         everything recorded for one session
 *   ?view=notifications what actually deserves the founder's attention
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const view = url.searchParams.get("view");

    if (view === "notifications") {
      const [pending, all] = await Promise.all([
        ledger.pendingNotifications(),
        db.select().from(collegeNotifications).orderBy(desc(collegeNotifications.lastSeenAt)).limit(50),
      ]);
      return Response.json({
        pending,
        all,
        note: pending.length
          ? "These conditions have recurred often enough to be worth a look."
          : "Nothing requires attention. Events are being recorded quietly.",
      });
    }

    const sessionId = url.searchParams.get("sessionId");
    if (sessionId) {
      const rows = await ledger.forSession(sessionId);
      return Response.json({ sessionId, entries: rows });
    }

    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    if (from && to) {
      const rows = await ledger.range({ from, to });
      return Response.json({ from, to, entries: rows, count: rows.length });
    }

    const date = url.searchParams.get("date") ?? brisbaneToday();
    const d = await ledger.day(date);
    return Response.json({
      ...d,
      note: "Raw observations in the order they occurred. Interpretation belongs to the audit, not here.",
    });
  } catch (e) {
    console.error("ledger read error", e);
    return Response.json(
      { error: "ledger read failed", detail: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}

/** Record a real-world context signal, or configure notification behaviour. */
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const action = String(body.action ?? "record");

    if (action === "notification_policy") {
      const row = await ledger.setNotificationPolicy({
        eventType: String(body.eventType ?? ""),
        severity: body.severity ?? "informational",
        occurrencesBeforeSurfacing: Number(body.occurrencesBeforeSurfacing ?? 1),
        notify: body.notify === true,
        reason: String(body.reason ?? ""),
      });
      return Response.json({
        policy: row,
        note: "Notification behaviour is institutional configuration. Arena does not decide what deserves interrupting you.",
      });
    }

    if (action === "suppress") {
      const key = String(body.notificationKey ?? "");
      const until = String(body.until ?? "");
      const reason = String(body.reason ?? "").trim();
      if (!key || !until || !reason) {
        return Response.json(
          { error: "notificationKey, until and reason are required" },
          { status: 400 }
        );
      }
      await ledger.suppressNotification(key, until, reason);
      return Response.json({ ok: true, note: `Silenced until ${until}.` });
    }

    // Default: record a real-world context signal.
    // This is how "I had an appointment" enters the timeline WITHOUT becoming
    // a permanent timetable change.
    const summary = String(body.summary ?? "").trim();
    if (!summary) return Response.json({ error: "summary required" }, { status: 400 });

    const id = await ledger.record({
      eventType: String(body.eventType ?? "real_world_interruption"),
      summary,
      detail: body.detail ?? {},
      sessionId: body.sessionId ?? null,
      slotId: body.slotId ?? null,
      courseId: body.courseId ?? null,
      actor: String(body.actor ?? "founder"),
      severity: body.severity ?? "informational",
      date: body.date ? String(body.date) : undefined,
      time: body.time ? String(body.time) : undefined,
    });

    return Response.json(
      {
        id,
        note: "Recorded as an observation on the institutional timeline. This explains a deviation; it does not change the timetable.",
      },
      { status: 201 }
    );
  } catch (e) {
    console.error("ledger write error", e);
    return Response.json(
      { error: "ledger write failed", detail: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
