// ============================================================================
// Lochie Life College — academic timekeeping (client-safe, pure)
// ============================================================================
// The Academic Calendar is institutional infrastructure: all week/semester
// positions derive from it, never from conversational memory or "today feels
// like week N". The institutional time zone is Australia/Brisbane (AEST, no
// daylight saving), so date arithmetic is done on calendar dates rather than
// raw UTC instants to avoid off-by-one-day drift.
// ============================================================================

export const INSTITUTIONAL_TZ = "Australia/Brisbane";

/** Current Brisbane calendar date as YYYY-MM-DD. */
export function brisbaneToday(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: INSTITUTIONAL_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  return parts; // en-CA yields YYYY-MM-DD
}

/** Brisbane weekday, 1 = Monday .. 7 = Sunday. */
export function brisbaneDayOfWeek(now: Date = new Date()): number {
  const name = new Intl.DateTimeFormat("en-US", {
    timeZone: INSTITUTIONAL_TZ,
    weekday: "short",
  }).format(now);
  const map: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return map[name] ?? 1;
}

/** Brisbane wall-clock time as HH:MM (24h). */
export function brisbaneTime(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: INSTITUTIONAL_TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(now);
}

/**
 * The institutional clock as structured parts. The live timetable uses this
 * rather than re-deriving timezone handling of its own.
 */
export function brisbaneNow(now: Date = new Date()): {
  isoDate: string;
  hour: number;
  minute: number;
  dayOfWeek: number;
} {
  const hhmm = brisbaneTime(now);
  const [h, m] = hhmm.split(":").map(Number);
  return {
    isoDate: brisbaneToday(now),
    hour: Number.isFinite(h) ? h : 0,
    minute: Number.isFinite(m) ? m : 0,
    dayOfWeek: brisbaneDayOfWeek(now),
  };
}

/** Long human date, e.g. "Sunday, 20 September 2026". */
export function brisbaneLongDate(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: INSTITUTIONAL_TZ,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(now);
}

/** Days between two ISO calendar dates (b - a), calendar-safe. */
export function daysBetween(aIso: string, bIso: string): number {
  const [ay, am, ad] = aIso.split("-").map(Number);
  const [by, bm, bd] = bIso.split("-").map(Number);
  const a = Date.UTC(ay, am - 1, ad);
  const b = Date.UTC(by, bm - 1, bd);
  return Math.round((b - a) / 86400000);
}

/** Add days to an ISO calendar date, returning ISO. */
export function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  const yy = t.getUTCFullYear();
  const mm = String(t.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(t.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/** Format an ISO date as "Mon 6 Jul 2026". */
export function formatIsoDate(iso: string): string {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12));
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: "UTC",
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(dt);
}

export interface WeekDerivation {
  /** 1-based week index against the term's start Monday. */
  weekIndex: number;
  /** True when weekIndex falls outside 1..weekCount. */
  outOfRange: boolean;
  /** Monday of the derived week (ISO), even when out of range. */
  mondayDate: string;
  /** How far past the final listed week we are, in weeks (0 when in range). */
  weeksPastEnd: number;
  daysSinceStart: number;
}

/**
 * Derive the academic week purely from the calendar. This is arithmetic, not
 * an opinion: the result is a FACT about the calendar, which may still
 * CONFLICT with what the institution declares about itself.
 */
export function deriveWeek(
  startMonday: string,
  weekCount: number,
  todayIso: string
): WeekDerivation {
  const daysSinceStart = daysBetween(startMonday, todayIso);
  const weekIndex = Math.floor(daysSinceStart / 7) + 1;
  const mondayDate = addDays(startMonday, (weekIndex - 1) * 7);
  const outOfRange = weekIndex < 1 || weekIndex > weekCount;
  const weeksPastEnd = weekIndex > weekCount ? weekIndex - weekCount : 0;
  return { weekIndex, outOfRange, mondayDate, weeksPastEnd, daysSinceStart };
}

export const DAY_NAMES = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

export function dayName(dow: number): string {
  return DAY_NAMES[dow] ?? "—";
}
