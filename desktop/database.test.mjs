import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { run } from "./database.mjs";

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  return child;
}

test("database command timeout waits for the killed child to close", async () => {
  let closed = false;
  let killed = false;
  await assert.rejects(
    run("initdb.exe", [], {}, 5, () => {
      const child = fakeChild();
      child.kill = () => {
        killed = true;
        setTimeout(() => {
          closed = true;
          child.emit("close", null, "SIGTERM");
        }, 10);
        return true;
      };
      return child;
    }),
    (error) => {
      assert.equal(killed, true, "timeout requests termination");
      assert.equal(closed, true, "timeout is not reported until the child has closed");
      assert.match(error.message, /initdb\.exe timed out/);
      return true;
    },
  );
});

test("database command returns captured output after a clean exit", async () => {
  const output = await run("postgres.exe", [], {}, 100, () => {
    const child = fakeChild();
    process.nextTick(() => {
      child.stdout.write("postgres ready\n");
      child.emit("close", 0, null);
    });
    return child;
  });
  assert.equal(output, "postgres ready\n");
});

test("database command rejects spawn errors after child cleanup", async () => {
  const spawnError = new Error("binary could not start");
  await assert.rejects(
    run("missing.exe", [], {}, 100, () => {
      const child = fakeChild();
      process.nextTick(() => {
        child.emit("error", spawnError);
        child.emit("close", -1, null);
      });
      return child;
    }),
    (error) => error === spawnError,
  );
});
