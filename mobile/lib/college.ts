// ===========================================================================
// THE CAMPUS CLIENT — talking to the one College
// ===========================================================================
// This file is deliberately thin. It holds no state the server doesn't hold,
// derives nothing the server derives, and phrases nothing the server phrases.
//
// The reason is the founder's rule: the iPhone is another institutional
// surface, not another institution. The moment this client starts computing
// "you're 4 sessions behind" locally, there are two accountability systems
// that can disagree, and the phone becomes a second source of truth. So every
// sentence the user reads in this app was written by the College.
// ===========================================================================

import * as SecureStore from "expo-secure-store";

const TOKEN_KEY = "college.device.token";
const BASE_KEY = "college.base.url";

let cachedToken: string | null = null;
let cachedBase: string | null = null;

export async function getBaseUrl(): Promise<string | null> {
  if (cachedBase) return cachedBase;
  cachedBase = await SecureStore.getItemAsync(BASE_KEY);
  return cachedBase;
}

export async function setBaseUrl(url: string): Promise<void> {
  const clean = url.trim().replace(/\/+$/, "");
  cachedBase = clean;
  await SecureStore.setItemAsync(BASE_KEY, clean);
}

export async function getToken(): Promise<string | null> {
  if (cachedToken) return cachedToken;
  cachedToken = await SecureStore.getItemAsync(TOKEN_KEY);
  return cachedToken;
}

/** The token lives in the iOS keychain, never in AsyncStorage or a file. */
export async function setToken(token: string): Promise<void> {
  cachedToken = token;
  await SecureStore.setItemAsync(TOKEN_KEY, token);
}

export async function forgetDevice(): Promise<void> {
  cachedToken = null;
  await SecureStore.deleteItemAsync(TOKEN_KEY);
}

export class CollegeError extends Error {
  status: number;
  /** The College's own explanation, when it gave one. */
  note: string;
  constructor(message: string, status: number, note = "") {
    super(message);
    this.status = status;
    this.note = note;
  }
}

async function request<T>(
  path: string,
  opts: { method?: string; body?: unknown; skipAuth?: boolean } = {}
): Promise<T> {
  const base = await getBaseUrl();
  if (!base) throw new CollegeError("No College address configured.", 0);

  const headers: Record<string, string> = { Accept: "application/json" };
  if (!opts.skipAuth) {
    const token = await getToken();
    if (!token) throw new CollegeError("This device is not paired.", 401);
    headers.Authorization = `Bearer ${token}`;
  }
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";

  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method: opts.method ?? "GET",
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  } catch {
    // Failure must be explicit. The app says the College is unreachable; it
    // never quietly shows stale data as though it were current.
    throw new CollegeError("The College could not be reached.", 0,
      "Check the address and your connection. Nothing shown is current.");
  }

  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new CollegeError("The College returned something unreadable.", res.status);
  }

  if (!res.ok) {
    throw new CollegeError(
      String(json.error ?? `Request failed (${res.status})`),
      res.status,
      String(json.note ?? "")
    );
  }
  return json as T;
}

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------

export async function pair(base: string, code: string, name: string) {
  await setBaseUrl(base);
  const r = await request<{ token: string; device: { name: string; surface: string; capabilities: string[] } }>(
    "/api/college/devices",
    { method: "POST", skipAuth: true, body: { action: "redeem", code, name, platform: "ios" } }
  );
  await setToken(r.token);
  return r.device;
}

// ---------------------------------------------------------------------------
// The briefing — the whole arrival experience in one call
// ---------------------------------------------------------------------------

export interface Briefing {
  where: {
    longDate: string;
    dayName: string;
    time: string;
    timezone: string;
    currentActivity: string;
    nextActivity: string | null;
  };
  temporal: {
    sinceLastInteraction: { known: boolean; days: number | null; label: string };
    goals: Array<{ id: string; title: string; status: string; condition: string; underTimePressure: boolean }>;
  };
  changed: { items: Array<{ what: string; when: string }>; materialCount: number; summary: string };
  accountability: {
    made: number;
    completed: number;
    missed: number;
    open: number;
    rhythmNote: string;
    summary: string;
    quiet: boolean;
    overdue: Array<{ id: string; statement: string; condition: string }>;
    patterns: Array<{ what: string; occurrences: number; windowDays: number; statedReasons: string[]; response: string }>;
    settings: { intensity: string };
  };
  matters: {
    external: {
      known: boolean;
      commitments: Array<{ id: string; provider: string; title: string; condition: string; imminent: boolean }>;
    };
    governance: Array<{ what: string; authorityRequired: string }>;
    conditions: string[];
  };
  next: {
    classAvailable: boolean;
    lifeActivity: boolean;
    title: string | null;
    startTime: string | null;
    activityType: string | null;
    handoff: string;
  };
  behaviour: { depth: string; continuity: string; reason: string };
  note: string;
}

export const fetchBriefing = () =>
  request<{ briefing: Briefing }>("/api/college/briefing").then((r) => r.briefing);

// ---------------------------------------------------------------------------
// Commitments — the phone genuinely holds this capability
// ---------------------------------------------------------------------------

export const makeCommitment = (statement: string, dueDate?: string, plannedMinutes?: number) =>
  request<{ commitment: { id: string }; note: string }>("/api/college/commitments", {
    method: "POST",
    body: { statement, dueDate, plannedMinutes },
  });

export const closeCommitment = (
  id: string,
  status: "completed" | "missed" | "deferred" | "cancelled" | "partial",
  extra: { actualMinutes?: number; missedReasonKind?: string; missedReason?: string } = {}
) =>
  request<{ note: string }>("/api/college/commitments", {
    method: "POST",
    body: { action: "close", id, status, ...extra },
  });

// ---------------------------------------------------------------------------
// Evidence — the camera's reason to exist
// ---------------------------------------------------------------------------

/**
 * A photograph of a TAFE sheet is a SOURCE, not an interpretation and not a
 * commitment. It enters the evidence pipeline and stops there; what the
 * College makes of it is a separate institutional act.
 */
export const captureEvidence = (content: string, context: string) =>
  request<{ note: string }>("/api/college/evidence", {
    method: "POST",
    body: { content, context, evidenceType: "captured_material", source: "campus_phone" },
  });

export const liveState = () => request<{ state: unknown }>("/api/college/live");
