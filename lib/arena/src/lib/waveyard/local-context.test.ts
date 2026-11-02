import assert from "node:assert/strict";
import test from "node:test";
import { LOCAL_OWNER_ID, requireUser, withWaveyardRequestContext } from "./local-context";

test("hosted Waveyard requests require a verified passkey session", async () => {
  const previousMode = process.env.NODE_ENV;
  const previousDesktopMode = process.env.ARENA_DESKTOP_MODE;
  process.env.NODE_ENV = "production";
  delete process.env.ARENA_DESKTOP_MODE;

  try {
    const request = new Request("https://arena.example/api/library/sessions");
    await assert.rejects(
      withWaveyardRequestContext(request, () => requireUser()),
      (error: unknown) => error instanceof Response && error.status === 401,
    );
    await assert.rejects(
      requireUser(),
      (error: unknown) => error instanceof Response && error.status === 401,
    );
  } finally {
    if (previousMode === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousMode;
    if (previousDesktopMode === undefined) delete process.env.ARENA_DESKTOP_MODE;
    else process.env.ARENA_DESKTOP_MODE = previousDesktopMode;
  }
});

test("loopback desktop mode retains the existing local owner identity", async () => {
  const previousMode = process.env.NODE_ENV;
  const previousDesktopMode = process.env.ARENA_DESKTOP_MODE;
  process.env.NODE_ENV = "production";
  process.env.ARENA_DESKTOP_MODE = "1";

  try {
    const user = await requireUser();
    assert.equal(user.id, LOCAL_OWNER_ID);
  } finally {
    if (previousMode === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousMode;
    if (previousDesktopMode === undefined) delete process.env.ARENA_DESKTOP_MODE;
    else process.env.ARENA_DESKTOP_MODE = previousDesktopMode;
  }
});
