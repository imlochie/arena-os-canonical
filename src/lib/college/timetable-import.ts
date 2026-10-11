// ============================================================================
// Lochie Life College — Timetable import (SERVER ONLY)
// ============================================================================
// Translates the Student Timetable design reference into structured timetable
// configuration. It is NOT a replica of the image: it is an initial
// configuration the founder reviews and edits before it becomes authoritative.
//
// Where the reference is ambiguous, the value is marked `needsConfiguration`
// with a note saying exactly what is unclear. Nothing is invented.
// See docs/timetable-source-reading.md for the full source reading.
// ============================================================================

import { db } from "@/db";
import {
  collegeDayThemes,
  collegeTimetablePeriods,
  collegeTimetableTemplateSlots,
} from "@/db/college";
import { eq } from "drizzle-orm";
import { createTimetableVersion, getActiveTimetableVersion } from "./timetable";

interface PeriodSeed {
  key: string;
  label: string;
  start: string;
  end: string;
  intent: string;
  icon: string;
  colorKey: string;
  needsConfiguration?: boolean;
  configurationNote?: string;
}

const PERIODS: PeriodSeed[] = [
  {
    key: "launch_sequence",
    label: "Launch Sequence",
    start: "10:15",
    end: "11:00",
    intent: "Become ready. Set the tone.",
    icon: "☀️",
    colorKey: "amber",
  },
  {
    key: "life_skills",
    label: "Life Skills & Home",
    start: "11:00",
    end: "12:00",
    intent: "Handle today's responsibilities.",
    icon: "🏠",
    colorKey: "emerald",
  },
  {
    key: "health_movement",
    label: "Health & Movement",
    start: "12:20",
    end: "13:20",
    intent: "Fuel your body. Clear your head.",
    icon: "🏋️",
    colorKey: "orange",
    needsConfiguration: true,
    configurationNote:
      "The reference leaves 12:00–12:20 unaccounted for between Life Skills & Home and Health & Movement. Confirm whether that gap is intentional.",
  },
  {
    key: "lunch",
    label: "Lunch",
    start: "13:20",
    end: "14:00",
    intent: "Refuel. Hydrate. Eat. No screens.",
    icon: "🍽️",
    colorKey: "yellow",
  },
  {
    key: "todays_subject",
    label: "Today's Subject",
    start: "14:00",
    end: "15:20",
    intent: "Who are you today?",
    icon: "🎓",
    colorKey: "violet",
  },
  {
    key: "life_period",
    label: "Life Period (Out & About)",
    start: "15:20",
    end: "17:00",
    intent: "Take action. Get out. Make it happen.",
    icon: "🚗",
    colorKey: "green",
  },
  {
    key: "garage_downtime",
    label: "Garage Downtime",
    start: "17:00",
    end: "19:30",
    intent: "Reset your brain. Decompress.",
    icon: "☕",
    colorKey: "stone",
    needsConfiguration: true,
    configurationNote:
      "Overlaps Dinner (18:30–19:30) in the reference. Confirm whether Dinner interrupts Garage Downtime or they genuinely run concurrently.",
  },
  {
    key: "dinner",
    label: "Dinner",
    start: "18:30",
    end: "19:30",
    intent: "Connect.",
    icon: "❤️",
    colorKey: "rose",
    needsConfiguration: true,
    configurationNote: "Overlaps Garage Downtime in the reference.",
  },
  {
    key: "evening_entertainment",
    label: "Evening Entertainment",
    start: "19:30",
    end: "22:30",
    intent: "Plex, films, gaming, vinyl, curation.",
    icon: "📺",
    colorKey: "indigo",
  },
  {
    key: "wind_down",
    label: "Wind Down",
    start: "22:30",
    end: "23:30",
    intent: "Protect tomorrow. Prepare. Sleep.",
    icon: "🌙",
    colorKey: "slate",
  },
  {
    key: "sleep",
    label: "Sleep",
    start: "23:30",
    end: "",
    intent: "Rest / Recover. Be ready for tomorrow.",
    icon: "🛏️",
    colorKey: "slate",
    needsConfiguration: true,
    configurationNote:
      "The reference prints no end time for Sleep (Wind Down ends at '11:30+'). Set a wake time if the College should reason about sleep duration.",
  },
];

const THEMES: Array<{ dow: number; theme: string; colorKey: string }> = [
  { dow: 1, theme: "RESET", colorKey: "emerald" },
  { dow: 2, theme: "EXPLORE", colorKey: "sky" },
  { dow: 3, theme: "ADULTING", colorKey: "amber" },
  { dow: 4, theme: "CREATE", colorKey: "violet" },
  { dow: 5, theme: "KICKOFF", colorKey: "rose" },
  { dow: 6, theme: "ADVENTURE", colorKey: "teal" },
  { dow: 7, theme: "SOUL", colorKey: "indigo" },
];

interface SlotSeed {
  period: string;
  days: number[];
  title: string;
  description?: string;
  behaviour: "fixed" | "scheduled" | "slotable";
  activityType: string;
  icon?: string;
  items?: string[];
  generatesSession?: boolean;
  sessionKind?: string;
  needsConfiguration?: boolean;
  configurationNote?: string;
}

const ALL = [1, 2, 3, 4, 5, 6, 7];

const SLOTS: SlotSeed[] = [
  // --- Fixed daily routine ------------------------------------------------
  {
    period: "launch_sequence",
    days: ALL,
    title: "Launch Sequence",
    behaviour: "fixed",
    activityType: "routine",
    icon: "☀️",
    items: [
      "Wake up",
      "Drink water",
      "Check laundry",
      "Shower",
      "Groom (shave when needed)",
      "Brush teeth",
      "Get changed",
      "Eat breakfast",
      "Plan the day",
      "Walk Loki",
    ],
  },
  {
    period: "health_movement",
    days: ALL,
    title: "Health & Movement",
    behaviour: "fixed",
    activityType: "health",
    icon: "🏋️",
    items: [
      "Drink water",
      "Eat something manageable",
      "Move your body",
      "Stretch if needed",
      "Freshen up if needed",
    ],
  },
  { period: "lunch", days: ALL, title: "Lunch", behaviour: "fixed", activityType: "routine", icon: "🍽️", items: ["Hydrate", "Eat", "No screens"] },
  {
    period: "garage_downtime",
    days: ALL,
    title: "Garage Downtime",
    behaviour: "fixed",
    activityType: "recovery",
    icon: "☕",
    items: ["Sit in the garage", "Chat", "Music", "Coffee / Drink", "Relax", "Think", "Light scrolling (don't get lost)"],
  },
  {
    period: "dinner",
    days: ALL,
    title: "Dinner",
    behaviour: "fixed",
    activityType: "relationship",
    icon: "❤️",
    items: ["Time with Kirra", "Eat dinner", "Help if needed", "Chat", "Be present"],
  },
  {
    period: "evening_entertainment",
    days: ALL,
    title: "Evening Entertainment",
    behaviour: "fixed",
    activityType: "entertainment",
    icon: "📺",
    items: ["Plex", "Movies / TV", "Gaming (if chosen)", "Vinyl", "Curate library", "YouTube"],
  },
  {
    period: "wind_down",
    days: ALL,
    title: "Wind Down",
    behaviour: "fixed",
    activityType: "recovery",
    icon: "🌙",
    items: ["Journal", "Brush teeth", "Shower if needed", "Prepare tomorrow", "Gentle scrolling (limit)", "Sleep"],
  },
  { period: "sleep", days: ALL, title: "Sleep", behaviour: "fixed", activityType: "recovery", icon: "🛏️", items: ["Rest / Recover", "Be ready for tomorrow"] },

  // --- Life Skills & Home: differs by day ---------------------------------
  { period: "life_skills", days: [1, 2], title: "Bedroom reset", behaviour: "scheduled", activityType: "household", icon: "🛏️", items: ["Bedroom reset", "Garage reset", "Surfaces & bins", "Laundry", "Shopping if needed", "Drive people", "General reset"] },
  { period: "life_skills", days: [3], title: "Report Pay", behaviour: "scheduled", activityType: "administrative", icon: "📋", items: ["Centerlink", "Paperwork", "Appointments", "Emails", "DoorDash (night)", "Life admin"] },
  { period: "life_skills", days: [4], title: "Pay bills", behaviour: "scheduled", activityType: "administrative", icon: "💳", items: ["Pay bills", "Paperwork", "Appointments", "Emails", "Shopping if needed", "General reset"] },
  { period: "life_skills", days: [5], title: "Plan weekend", behaviour: "scheduled", activityType: "administrative", icon: "🗓️", items: ["Plan weekend", "Check weather", "Pack if needed", "Fuel up / car", "Get ready", "Set intentions"] },
  { period: "life_skills", days: [6], title: "House reset", behaviour: "scheduled", activityType: "household", icon: "🏠", items: ["House reset", "Laundry", "Groceries", "Clean as needed", "Prepare for week", "General reset"] },
  { period: "life_skills", days: [7], title: "Plan week ahead", behaviour: "scheduled", activityType: "administrative", icon: "📅", items: ["Plan week ahead", "Declutter", "Deep clean", "Groceries", "Set intentions"] },

  // --- Today's Subject: the academic spine, slotable ----------------------
  {
    period: "todays_subject",
    days: [1],
    title: "LOCO PRØD",
    description: "Create music.",
    behaviour: "slotable",
    activityType: "creative",
    icon: "🎵",
    items: ["Produce", "Remix", "Mix", "Experiment"],
    generatesSession: true,
    sessionKind: "practice",
  },
  {
    period: "todays_subject",
    days: [2],
    title: "Digital Lab",
    description: "Tech. Learn. Build.",
    behaviour: "slotable",
    activityType: "academic",
    icon: "💻",
    items: ["Plex", "AI", "Editing", "Automation", "Learn something"],
    generatesSession: true,
    sessionKind: "lesson",
  },
  {
    period: "todays_subject",
    days: [3],
    title: "Adulting",
    description: "Sort life admin.",
    behaviour: "slotable",
    activityType: "academic",
    icon: "📋",
    items: ["Finances", "Paperwork", "Future planning", "Course research", "Life organisation"],
    generatesSession: true,
    sessionKind: "lesson",
  },
  {
    period: "todays_subject",
    days: [4],
    title: "Instrument Practice",
    description: "Make music.",
    behaviour: "slotable",
    activityType: "creative",
    icon: "🎸",
    items: ["Guitar", "Drums", "Singing", "Songwriting"],
    generatesSession: true,
    sessionKind: "practice",
  },
  {
    period: "todays_subject",
    days: [5],
    title: "Weekend Kickoff",
    description: "Finish, reflect, get excited.",
    behaviour: "slotable",
    activityType: "recovery",
    icon: "🎉",
    items: ["Wrap up projects", "Finish loose ends", "Get ready for the weekend"],
    generatesSession: true,
    sessionKind: "retrospective",
  },
  {
    period: "todays_subject",
    days: [6],
    title: "Adventure",
    description: "Get out.",
    behaviour: "slotable",
    activityType: "adventure",
    icon: "🌊",
    items: ["Beach", "Drive", "Skate", "Cafe", "Explore"],
  },
  {
    period: "todays_subject",
    days: [7],
    title: "Soul Session",
    description: "Reflect & reset.",
    behaviour: "slotable",
    activityType: "recovery",
    icon: "☯️",
    items: ["Vinyl", "Journal", "Read", "Reflect", "Reset"],
    generatesSession: true,
    sessionKind: "retrospective",
  },

  // --- Life Period --------------------------------------------------------
  { period: "life_period", days: [1], title: "Gym / Movement", behaviour: "scheduled", activityType: "health", icon: "🏃", items: ["Workout", "Mobility", "Walk Loki", "Shower", "Improve"] },
  { period: "life_period", days: [2], title: "Skate / Flow", behaviour: "scheduled", activityType: "health", icon: "🛹", items: ["Skate", "Film", "Push / Flow", "Be outside", "Progress"] },
  {
    period: "life_period",
    days: [3],
    title: "DoorDash Night",
    behaviour: "scheduled",
    activityType: "administrative",
    icon: "🚗",
    items: ["5:30 – 8:30", "3 – 4 Hours", "Dinner Rush", "Earn / Explore", "Get Out There"],
    needsConfiguration: true,
    configurationNote:
      "The reference prints DoorDash Night as 5:30–8:30 PM, which falls outside the Life Period band (3:20–5:00) and overlaps Garage Downtime and Dinner. Confirm the intended time.",
  },
  { period: "life_period", days: [4], title: "Music Practice", behaviour: "scheduled", activityType: "creative", icon: "🎶", items: ["Guitar / Drums", "Write / Sing", "Record ideas", "Jam", "Make something"] },
  { period: "life_period", days: [5], title: "Out & About", behaviour: "scheduled", activityType: "adventure", icon: "🎊", items: ["Go somewhere", "See people", "Do something", "Live a little"] },
  { period: "life_period", days: [6], title: "Adventure Continues", behaviour: "scheduled", activityType: "adventure", icon: "⛰️", items: ["Hike / Explore", "Café / Markets", "Take photos", "Live a little"] },
  { period: "life_period", days: [7], title: "Time with Kirra", behaviour: "scheduled", activityType: "relationship", icon: "💞", items: ["Spend time", "Talk", "Do something together"] },
];

export interface ImportResult {
  versionId: string;
  versionLabel: string;
  periods: number;
  themes: number;
  slots: number;
  needsConfiguration: Array<{ what: string; note: string }>;
  note: string;
}

/**
 * Import the reference structure as a NEW timetable version.
 * Nothing is overwritten; the founder reviews before it becomes authoritative.
 */
export async function importReferenceTimetable(opts: {
  label?: string;
  reason: string;
  termId?: string | null;
}): Promise<ImportResult> {
  const version = await createTimetableVersion({
    label: opts.label ?? "Semester 1 — imported from Student Timetable reference",
    reason: opts.reason,
    termId: opts.termId ?? null,
    copyFromId: null, // a fresh structure, not a copy
  });

  const needsConfiguration: Array<{ what: string; note: string }> = [];
  const periodIds = new Map<string, string>();

  for (let i = 0; i < PERIODS.length; i++) {
    const p = PERIODS[i];
    const [row] = await db
      .insert(collegeTimetablePeriods)
      .values({
        versionId: version.id,
        key: p.key,
        label: p.label,
        sequence: i,
        startTime: p.start,
        endTime: p.end,
        intent: p.intent,
        icon: p.icon,
        colorKey: p.colorKey,
        needsConfiguration: p.needsConfiguration ?? false,
        configurationNote: p.configurationNote ?? "",
      })
      .returning();
    periodIds.set(p.key, row.id);
    if (p.needsConfiguration) {
      needsConfiguration.push({ what: p.label, note: p.configurationNote ?? "" });
    }
  }

  for (const t of THEMES) {
    await db.insert(collegeDayThemes).values({
      versionId: version.id,
      dayOfWeek: t.dow,
      theme: t.theme,
      colorKey: t.colorKey,
    });
  }

  let slotCount = 0;
  for (const s of SLOTS) {
    const periodId = periodIds.get(s.period) ?? null;
    const period = PERIODS.find((p) => p.key === s.period);
    for (const day of s.days) {
      await db.insert(collegeTimetableTemplateSlots).values({
        versionId: version.id,
        periodId,
        dayOfWeek: day,
        startTime: period?.start ?? "",
        endTime: period?.end ?? "",
        sequence: PERIODS.findIndex((p) => p.key === s.period),
        title: s.title,
        description: s.description ?? "",
        slotBehaviour: s.behaviour,
        activityType: s.activityType,
        categoryKey: s.period,
        sessionKind: s.sessionKind ?? "",
        generatesSession: s.generatesSession ?? false,
        informsCollegeState: true,
        icon: s.icon ?? period?.icon ?? "",
        colorKey: period?.colorKey ?? "",
        items: JSON.stringify(s.items ?? []),
        recurrence: "weekly",
        needsConfiguration: s.needsConfiguration ?? false,
        configurationNote: s.configurationNote ?? "",
      });
      slotCount++;
    }
    if (s.needsConfiguration) {
      needsConfiguration.push({ what: s.title, note: s.configurationNote ?? "" });
    }
  }

  return {
    versionId: version.id,
    versionLabel: version.label,
    periods: PERIODS.length,
    themes: THEMES.length,
    slots: slotCount,
    needsConfiguration,
    note: "Imported as a new timetable version from the design reference. Ambiguous values are flagged rather than guessed — review them before treating this as authoritative. No course is attached to any slot yet; course placement is an explicit choice.",
  };
}

/** Has the reference structure already been imported? */
export async function timetableConfigured(): Promise<boolean> {
  const v = await getActiveTimetableVersion();
  if (!v) return false;
  const rows = await db
    .select()
    .from(collegeTimetableTemplateSlots)
    .where(eq(collegeTimetableTemplateSlots.versionId, v.id))
    .limit(1);
  return rows.length > 0;
}
