import test from "node:test";
import assert from "node:assert/strict";
import { cleanupAdmissionProbe } from "./arcade/linux-admission.mjs";

function fixture(overrides = {}) {
  const calls = [];
  return {
    calls,
    args: {
      child: { stdin: { end: () => calls.push("eof") }, kill: signal => calls.push(signal) },
      closed: Promise.resolve(0), attached: true, groupCreated: true,
      group: "/owned/group", directory: "/owned/temp",
      io: {
        writeFile: async (file) => calls.push(file),
        rmdir: async file => calls.push(file),
        rm: async file => calls.push(file),
        ...overrides,
      },
    },
  };
}

test("failed attachment terminates the still-blocked trusted launcher", async () => {
  const { args, calls } = fixture();
  args.attached = false;
  const result = await cleanupAdmissionProbe(args);
  assert.deepEqual(calls, ["eof", "SIGKILL", "/owned/group/cgroup.kill", "/owned/group", "/owned/temp"]);
  assert.equal(result.probeGroupCleaned, true);
  assert.deepEqual(result.cleanupErrors, []);
});

test("attached cleanup kills only the owned group, never global Wine processes", async () => {
  const { args, calls } = fixture();
  const result = await cleanupAdmissionProbe(args);
  assert.equal(result.probeGroupCleaned, true);
  assert.ok(!calls.includes("SIGKILL"));
  assert.equal(calls[1], "/owned/group/cgroup.kill");
});

test("a failed group kill and hung child return bounded failure evidence", async () => {
  const { args, calls } = fixture({
    writeFile: async () => { throw new Error("denied"); },
    rmdir: async () => { throw new Error("still occupied"); },
  });
  args.closed = new Promise(() => {});
  args.timeoutMs = 10;
  const result = await cleanupAdmissionProbe(args);
  assert.equal(result.probeGroupCleaned, false);
  assert.equal(result.cleanupErrors.length, 3);
  assert.match(result.cleanupErrors.join(" "), /denied.*timed out.*still occupied/);
  assert.ok(calls.includes("/owned/temp"));
});

test("cleanup never removes a group it did not create", async () => {
  const { args, calls } = fixture();
  Object.assign(args, { child: undefined, closed: undefined, groupCreated: false });
  const result = await cleanupAdmissionProbe(args);
  assert.equal(result.probeGroupCleaned, true);
  assert.deepEqual(calls, ["/owned/temp"]);
});
