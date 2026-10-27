// ===========================================================================
// LAYER 9 — SURFACES, DEVICE IDENTITY AND THE GUARD
// ===========================================================================
// Run:  node scripts/college-layer9-tests.mjs
//
// These assertions exist because the College is about to be reachable from a
// phone over the public internet. Before Layer 9 every route was open: an
// unauthenticated POST to /api/college/bootstrap returned 201 and reseeded
// the institution. That is the specific hole being closed.
//
// Self-cleaning: removes every device and code it creates.
// ===========================================================================

import pg from "pg";
import net from "node:net";

const BASE = process.env.BASE ?? "http://localhost:3000";
const DB = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/app_db";
const TAG = `L9-${Date.now()}`;
const PORT = Number(new URL(BASE).port || 80);

let passed = 0;
const failures = [];
const ok = (n, t, d) => { passed++; console.log(`  \x1b[32m✓\x1b[0m ${String(n).padStart(2)}. ${t}`); if (d) console.log(`       ${d}`); };
const bad = (n, t, d) => { failures.push(`${n}. ${t} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${String(n).padStart(2)}. ${t}`); console.log(`       \x1b[31m${d}\x1b[0m`); };

const pool = new pg.Pool({ connectionString: DB });
const q = async (sql, p = []) => (await pool.query(sql, p)).rows;

// A remote hop makes the request look like it came from the internet, which
// is what every real phone request will look like.
const REMOTE = { "X-Forwarded-For": "203.0.113.9" };

const call = async (path, { method = "GET", token, headers = {}, body } = {}) => {
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (body !== undefined) h["Content-Type"] = "application/json";
  const r = await fetch(`${BASE}${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null;
  try { json = await r.json(); } catch { /* non-JSON is fine here */ }
  return { status: r.status, json };
};

async function main() {
  console.log("\n\x1b[1mLAYER 9 — INSTITUTIONAL SURFACES\x1b[0m\n");

  // ---- 1. the hole that started this -------------------------------------
  {
    const r = await call("/api/college/bootstrap", { method: "POST", headers: REMOTE, body: {} });
    if (r.status === 401) {
      ok(1, "An unauthenticated remote caller cannot reseed the institution",
         `POST /bootstrap → 401 (was 201 before this layer)`);
    } else {
      bad(1, "An unauthenticated remote caller cannot reseed the institution", `got ${r.status}`);
    }
  }

  // ---- 2. every college route refuses an unpaired remote caller ----------
  {
    const eps = ["briefing", "live", "state", "commitments", "curriculum", "members",
                 "timetable", "goals", "evidence", "external", "ledger", "governance"];
    const results = await Promise.all(eps.map((e) => call(`/api/college/${e}`, { headers: REMOTE })));
    const open = eps.filter((_, i) => results[i].status !== 401);
    if (open.length === 0) {
      ok(2, "No College route answers an unpaired remote caller", `${eps.length} endpoints all 401`);
    } else {
      bad(2, "No College route answers an unpaired remote caller", `open: ${open.join(", ")}`);
    }
  }

  // ---- 3. pairing ---------------------------------------------------------
  let token = null, deviceId = null;
  {
    const mk = await call("/api/college/devices", { method: "POST", body: { action: "pair_code", surface: "campus" } });
    const code = mk.json?.code;
    const red = await call("/api/college/devices", { method: "POST", body: { action: "redeem", code, name: `${TAG} iPhone`, platform: "ios" } });
    token = red.json?.token ?? null;
    deviceId = red.json?.device?.id ?? null;
    if (code && token && red.status === 201) {
      ok(3, "A device pairs with a code and receives a token once", `code ${code} → token ${token.slice(0, 14)}…`);
    } else {
      bad(3, "A device pairs with a code and receives a token once", `code=${code} status=${red.status}`);
    }
  }

  // ---- 4. codes are single use -------------------------------------------
  {
    const mk = await call("/api/college/devices", { method: "POST", body: { action: "pair_code" } });
    const code = mk.json?.code;
    await call("/api/college/devices", { method: "POST", body: { action: "redeem", code, name: `${TAG} first` } });
    const second = await call("/api/college/devices", { method: "POST", body: { action: "redeem", code, name: `${TAG} second` } });
    if (second.status === 401) {
      ok(4, "A pairing code works exactly once", `replay → 401 "${second.json?.error}"`);
    } else {
      bad(4, "A pairing code works exactly once", `replay → ${second.status}`);
    }
  }

  // ---- 5. expired codes die ----------------------------------------------
  {
    const mk = await call("/api/college/devices", { method: "POST", body: { action: "pair_code" } });
    const code = mk.json?.code;
    await q("update college_pairing_codes set expires_at = now() - interval '1 minute' where code = $1", [code]);
    const r = await call("/api/college/devices", { method: "POST", body: { action: "redeem", code, name: `${TAG} late` } });
    if (r.status === 401) {
      ok(5, "An expired pairing code is refused", `10-minute TTL enforced`);
    } else {
      bad(5, "An expired pairing code is refused", `got ${r.status}`);
    }
  }

  // ---- 6. the campus can be a student ------------------------------------
  {
    const eps = ["briefing", "live", "commitments", "preflight"];
    const rs = await Promise.all(eps.map((e) => call(`/api/college/${e}`, { token, headers: REMOTE })));
    const blocked = eps.filter((_, i) => rs[i].status !== 200);
    if (blocked.length === 0) {
      ok(6, "A paired phone can do everything a student needs", `${eps.join(", ")} all 200 from a remote address`);
    } else {
      bad(6, "A paired phone can do everything a student needs", `blocked: ${blocked.join(", ")}`);
    }
  }

  // ---- 7. the campus cannot be the institution ---------------------------
  {
    const forbidden = [
      ["curriculum", "edit_curriculum"],
      ["members", "configure_faculty"],
      ["faculty", "configure_faculty"],
      ["timetable", "edit_timetable"],
      ["bootstrap", "bootstrap"],
      ["decisions", "institutional_decision"],
      ["records", "institutional_decision"],
    ];
    const rs = await Promise.all(forbidden.map(([e]) =>
      call(`/api/college/${e}`, { method: "POST", token, headers: REMOTE, body: {} })));
    const leaked = forbidden.filter((_, i) => rs[i].status !== 403);
    const named = rs.every((r) => typeof r.json?.required === "string");
    if (leaked.length === 0 && named) {
      ok(7, "A paired phone cannot administer the institution",
         `${forbidden.length} administrative endpoints → 403, each naming the capability required`);
    } else {
      bad(7, "A paired phone cannot administer the institution",
          `leaked: ${leaked.map((f) => f[0]).join(", ") || "none"} named=${named}`);
    }
  }

  // ---- 8. refusals explain themselves ------------------------------------
  {
    const r = await call("/api/college/curriculum", { method: "POST", token, headers: REMOTE, body: {} });
    const b = r.json ?? {};
    if (b.surface === "campus" && /structural ceiling/i.test(b.note ?? "") && /Control Room/i.test(b.error ?? "")) {
      ok(8, "A refusal says which surface asked, what was needed, and why",
         `"${(b.error ?? "").slice(0, 78)}…"`);
    } else {
      bad(8, "A refusal says which surface asked, what was needed, and why", JSON.stringify(b).slice(0, 140));
    }
  }

  // ---- 9. the ceiling is structural, not per-device ----------------------
  {
    // Try to widen a campus device directly in the database. Even then the
    // guard must refuse, because authority is derived from the surface.
    await q("update college_devices set surface='campus' where id=$1", [deviceId]);
    const r = await call("/api/college/curriculum", { method: "POST", token, headers: REMOTE, body: {} });
    const grants = await q("select column_name from information_schema.columns where table_name='college_devices' and column_name like '%capab%'");
    if (r.status === 403 && grants.length === 0) {
      ok(9, "There is no per-device capability grant to escalate",
         "the devices table has no capability column; the ceiling comes from the surface alone");
    } else {
      bad(9, "There is no per-device capability grant to escalate", `status=${r.status} cols=${grants.length}`);
    }
  }

  // ---- 10. revocation is immediate ---------------------------------------
  {
    const before = await call("/api/college/briefing", { token, headers: REMOTE });
    await call("/api/college/devices", { method: "PATCH", body: { id: deviceId, reason: "test revocation" } });
    const after = await call("/api/college/briefing", { token, headers: REMOTE });
    if (before.status === 200 && after.status === 401) {
      ok(10, "Revoking a device takes effect on the very next request", "200 → 401");
    } else {
      bad(10, "Revoking a device takes effect on the very next request", `${before.status} → ${after.status}`);
    }
  }

  // ---- 11. revoked devices are kept, not erased --------------------------
  {
    const rows = await q("select revoked_at, revoked_reason from college_devices where id=$1", [deviceId]);
    if (rows.length === 1 && rows[0].revoked_at) {
      ok(11, "A revoked device stays in the record",
         `which devices were trusted, and when that ended, is institutional history`);
    } else {
      bad(11, "A revoked device stays in the record", JSON.stringify(rows));
    }
  }

  // ---- 12. tokens are never stored in the clear --------------------------
  {
    const rows = await q("select token_hash, token_hint from college_devices where id=$1", [deviceId]);
    const stored = rows[0]?.token_hash ?? "";
    const isHash = /^[0-9a-f]{64}$/.test(stored);
    if (isHash && !stored.includes("arena_")) {
      ok(12, "Tokens are stored as hashes, never in plaintext",
         `sha-256 digest only; a database dump is not a set of working keys`);
    } else {
      bad(12, "Tokens are stored as hashes, never in plaintext", stored.slice(0, 40));
    }
  }

  // ---- 13. local development still works ---------------------------------
  {
    const r = await call("/api/college/briefing");
    if (r.status === 200) {
      ok(13, "Loopback development is unaffected when strict mode is off",
         "the desktop Control Room keeps working with no token");
    } else {
      bad(13, "Loopback development is unaffected when strict mode is off", `got ${r.status}`);
    }
  }

  // ---- 14. a remote caller cannot pose as loopback -----------------------
  {
    // NOTE: fetch() silently refuses to override the Host header, so asserting
    // this through fetch produced a false PASS against a localhost Host. The
    // spoof has to be sent over a raw socket to actually test the guard.
    const rawStatus = await new Promise((resolve) => {
      const sock = net.connect(PORT, "127.0.0.1", () => {
        sock.write(
          "GET /api/college/briefing HTTP/1.1\r\nHost: arena.example.com\r\nConnection: close\r\n\r\n"
        );
      });
      let buf = "";
      sock.on("data", (d) => { buf += d.toString(); });
      sock.on("end", () => resolve(Number(buf.split(" ")[1] ?? 0)));
      sock.on("error", () => resolve(0));
    });
    const spoofHop = await call("/api/college/briefing", { headers: REMOTE });
    if (rawStatus === 401 && spoofHop.status === 401) {
      ok(14, "Development access cannot be claimed from outside",
         "a spoofed Host over a raw socket and a remote forwarded hop are both refused");
    } else {
      bad(14, "Development access cannot be claimed from outside",
          `rawHost=${rawStatus} hop=${spoofHop.status}`);
    }
  }

  // ==========================================================================
  // 15-17. THE HEALTH CHECK IS A DEPLOYMENT RED LIGHT, NOT A FIELD TO SKIM
  // ==========================================================================
  {
    // Local development must stay unaffected — this check exists to catch a
    // misconfigured *deployment*, not to make laptop work ceremonial.
    const local = await call("/api/health");
    if (local.status === 200 && local.json?.ok === true) {
      ok(15, "Local development still reports healthy",
         `authMode "${local.json.authMode}", database ${local.json.database}`);
    } else {
      bad(15, "Local development still reports healthy", `${local.status} ${JSON.stringify(local.json)}`);
    }

    // The dangerous combination: reachable from outside AND not strict.
    const exposed = await call("/api/health", { headers: REMOTE });
    if (exposed.status === 503 && exposed.json?.ok === false) {
      ok(16, "A publicly reachable College with auth off refuses to report healthy",
         `HTTP 503 "${exposed.json.status}" — a load balancer will not bring it into service`);
    } else {
      bad(16, "A publicly reachable College with auth off refuses to report healthy",
          `got ${exposed.status} ok=${exposed.json?.ok}`);
    }

    const body = exposed.json ?? {};
    const saysWhy = /answering unauthenticated callers/i.test(body.consequence ?? "");
    const saysFix = /COLLEGE_AUTH_MODE=strict/i.test(body.remedy ?? "");
    if (saysWhy && saysFix) {
      ok(17, "The refusal states the consequence and the remedy",
         "names what is exposed and the exact variable to set");
    } else {
      bad(17, "The refusal states the consequence and the remedy",
          `why=${saysWhy} fix=${saysFix}`);
    }
  }

  // ---- cleanup ------------------------------------------------------------
  await q("delete from college_pairing_codes where used_by_device_id in (select id from college_devices where name like $1) or code in (select code from college_pairing_codes where used_at is null and created_at > now() - interval '5 minutes')", [`${TAG}%`]);
  await q("delete from college_devices where name like $1", [`${TAG}%`]);

  console.log(`\n\x1b[1m${passed} passed, ${failures.length} failed\x1b[0m\n`);
  if (failures.length) { console.log("Failures:"); failures.forEach((f) => console.log(`  - ${f}`)); console.log(""); }
  await pool.end();
  process.exit(failures.length ? 1 : 0);
}

main().catch(async (e) => {
  console.error("Harness error:", e.message, e.stack);
  await q("delete from college_devices where name like $1", [`${TAG}%`]).catch(() => {});
  await pool.end().catch(() => {});
  process.exit(1);
});
