/**
 * Spaces background daemon (docs/spaces-autonomy.md Phase A).
 *
 * Opt-in ONLY — never started automatically:
 *   npm run spaces:daemon            (foreground)
 *   npm run spaces:daemon -- --once  (one tick, then exit — cron/Task Scheduler friendly)
 *
 * What it does on every tick (default interval 60s, --interval ms):
 *   1. POST /api/spaces/tick   — due space runs advance without any page open
 *   2. Approval auto-resume    — for every space whose latest mission is
 *      `awaiting_approval`, if its blocking approval has been DECIDED
 *      (approved or denied — i.e. no pending approval remains for that
 *      mission), the mission resumes exactly once: an approved action is
 *      claimed and executed single-claim; a denied one is honestly refused
 *      and the agent adapts.
 *   3. Expiry sweep            — approvals older than --approval-ttl-ms
 *      (default 24h) with no decision are marked denied by "expired" so a
 *      mission can never wait forever on a forgotten request.
 *
 * Everything runs against the app's own HTTP surface (ARENA_APP_URL, default
 * http://127.0.0.1:3000) — the daemon is just another client, so all normal
 * auth, governance, and journaling apply. It never touches the database
 * directly.
 *
 * Honest logging only: every action and refusal is printed as it happened.
 */

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};

const APP_URL = (process.env.ARENA_APP_URL ?? option("url", "http://127.0.0.1:3000")).replace(/\/$/, "");
const INTERVAL_MS = Math.max(5_000, Number(option("interval", "60000"), 10));
const APPROVAL_TTL_MS = Math.max(60_000, Number(option("approval-ttl-ms", String(24 * 60 * 60 * 1000)), 10));
const ONCE = flag("once");

const inflightResumes = new Set(); // spaceIds with a resume in flight this process

async function api(pathname, init) {
  const response = await fetch(`${APP_URL}${pathname}`, init);
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

function log(event, detail = "") {
  console.log(`[spaces-daemon ${new Date().toISOString()}] ${event}${detail ? " — " + detail : ""}`);
}

async function tickSpaces() {
  try {
    const r = await api("/api/spaces/tick", { method: "POST" });
    if (r.status === 200 && Array.isArray(r.body.ran) && r.body.ran.length > 0) {
      log("space runs advanced", r.body.ran.join(", "));
    }
    return true;
  } catch (e) {
    log("tick failed (is the app running?)", String(e instanceof Error ? e.message : e));
    return false;
  }
}

async function resumeDecidedMissions() {
  let spaces;
  try {
    const r = await api("/api/spaces");
    if (r.status !== 200 || !Array.isArray(r.body.spaces)) return;
    spaces = r.body.spaces;
  } catch {
    return; // app unreachable — tick already logged it
  }
  for (const space of spaces) {
    try {
      const m = await api(`/api/spaces/${space.id}/mission`);
      const mission = m.body?.mission;
      if (!mission || mission.status !== "awaiting_approval") continue;
      const a = await api(`/api/spaces/approvals?spaceId=${space.id}&status=pending`);
      const pending = Array.isArray(a.body?.approvals) ? a.body.approvals : [];
      const blocking = pending.filter((p) => !p.missionId || p.missionId === mission.id);
      if (blocking.length > 0) continue; // still waiting on a human
      if (inflightResumes.has(space.id)) continue;
      inflightResumes.add(space.id);
      log("resuming mission after approval decision", `space ${space.id.slice(0, 8)} (mission ${mission.id.slice(0, 8)})`);
      const resume = await api(`/api/spaces/${space.id}/mission`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}), // continue: goal/plan from the row
      });
      if (resume.status !== 200) {
        log("mission resume FAILED", `space ${space.id.slice(0, 8)}: ${JSON.stringify(resume.body).slice(0, 200)}`);
      } else {
        const s = resume.body?.mission?.status;
        log("mission resumed", `space ${space.id.slice(0, 8)} → ${s}`);
      }
      inflightResumes.delete(space.id);
    } catch (e) {
      inflightResumes.delete(space.id);
      log("mission resume error", `space ${space.id.slice(0, 8)}: ${String(e instanceof Error ? e.message : e)}`);
    }
  }
}

async function expireStaleApprovals() {
  try {
    const r = await api("/api/spaces/approvals?status=pending");
    const pending = Array.isArray(r.body?.approvals) ? r.body.approvals : [];
    const cutoff = Date.now() - APPROVAL_TTL_MS;
    for (const p of pending) {
      if (new Date(p.requestedAt).getTime() < cutoff) {
        const d = await api("/api/spaces/approvals", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: p.id, decision: "deny", decidedBy: "daemon:expired (ttl)" }),
        });
        log(d.status === 200 ? "expired stale approval" : "expiry failed", `${p.id.slice(0, 8)} (${p.actionClass})`);
      }
    }
  } catch {
    /* app unreachable — already logged by tick */
  }
}

async function tick() {
  const appUp = await tickSpaces();
  if (appUp) {
    await resumeDecidedMissions();
    await expireStaleApprovals();
  }
}

log("started", `${APP_URL} · interval ${INTERVAL_MS}ms · approval ttl ${APPROVAL_TTL_MS}ms${ONCE ? " · single tick" : ""}`);
if (ONCE) {
  await tick();
  process.exit(0);
}
// Unhandled rejections must never kill the daemon silently.
process.on("unhandledRejection", (e) => log("unhandled rejection", String(e)));
while (true) {
  await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
  await tick();
}
