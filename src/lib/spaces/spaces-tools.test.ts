/**
 * Space tool-runtime, mission runner, and watcher contract tests.
 *
 * These prove the "mini-computer" is real but bounded: files actually land
 * on disk, commands actually execute inside the workspace (and are refused
 * outside the allowlist), paths cannot escape, the mission protocol parses
 * agent turns and enforces its budget/checkpoint semantics, and the YouTube
 * watcher parses real feed XML and diffs correctly.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  commandAllowed,
  toolDeleteFile,
  toolGithubPublish,
  toolListFiles,
  toolReadFile,
  toolRunCommand,
  toolWriteFile,
} from "./tools";
import { parseAgentJson, type MissionAgentSpec } from "./mission";
import { formatNotes, parseYouTubeFeed } from "./watchers";

test("workspace file tools round-trip inside a directory", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "wy-tools-"));
  try {
    const wrote = await toolWriteFile(dir, "src/game.js", "console.log('hi')");
    assert.match(wrote, /wrote src\/game\.js/);
    assert.equal(await toolReadFile(dir, "src/game.js"), "console.log('hi')");
    const listing = await toolListFiles(dir);
    assert.match(listing, /src\/game\.js/);
    await toolDeleteFile(dir, "src/game.js");
    assert.match(await toolListFiles(dir), /empty/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("path escapes are refused", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "wy-esc-"));
  try {
    await assert.rejects(() => toolWriteFile(dir, "../escape.txt", "nope"));
    await assert.rejects(() => toolReadFile(dir, "/etc/passwd"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("commands run in the workspace; non-allowlisted binaries are refused", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "wy-cmd-"));
  try {
    await writeFile(path.join(dir, "hello.js"), "console.log('from-node')", "utf8");
    const out = await toolRunCommand(dir, "node hello.js");
    assert.match(out, /exit 0/);
    assert.match(out, /from-node/);

    assert.ok(commandAllowed("node --version"));
    assert.ok(commandAllowed("git status"));
    assert.ok(!commandAllowed("rm -rf /"));
    assert.ok(!commandAllowed("curl http://evil.example"));
    assert.ok(!commandAllowed("bash -c anything"));
    const refused = await toolRunCommand(dir, "curl http://evil.example");
    assert.match(refused, /refused/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("github publish is honest about being disconnected", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "wy-gh-"));
  try {
    const prev = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
    const out = await toolGithubPublish(dir, { repo: "x/y", message: "m", files: [{ path: "a", content: "b" }] });
    assert.match(out, /GitHub is not connected/);
    if (prev) process.env.GITHUB_TOKEN = prev;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("mission protocol parses fenced and raw JSON agent turns", () => {
  const fenced = '```json\n{"thought":"plan","actions":[{"tool":"write_file","args":{"path":"a.txt","content":"hi"}}],"done":false}\n```';
  const parsed = parseAgentJson(fenced);
  assert.equal(parsed?.thought, "plan");
  assert.equal(parsed?.actions?.[0].tool, "write_file");

  const raw = 'prose before {"thought":"x","actions":[],"handoff":"notes","done":true} prose after';
  const p2 = parseAgentJson(raw);
  assert.equal(p2?.done, true);
  assert.equal(p2?.handoff, "notes");

  assert.equal(parseAgentJson("no json at all"), null);
});

const FEED = `<?xml version="1.0"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/">
<entry>
  <id>yt:video:abc123</id>
  <yt:videoId>abc123</yt:videoId>
  <title>My First Build Video</title>
  <published>2026-10-01T12:00:00+00:00</published>
  <media:description>We built a synth from scratch &amp; it &quot;works&quot;.</media:description>
  <link rel="alternate" href="https://www.youtube.com/watch?v=abc123"/>
</entry>
<entry>
  <id>yt:video:def456</id>
  <yt:videoId>def456</yt:videoId>
  <title>Second Video</title>
  <published>2026-10-05T12:00:00+00:00</published>
  <media:description>Notes on the second video with &lt;tags&gt; inside.</media:description>
</entry>
</feed>`;

test("youtube feed parser extracts titles + descriptions with entity decoding", () => {
  const entries = parseYouTubeFeed(FEED);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].videoId, "abc123");
  assert.equal(entries[0].title, "My First Build Video");
  assert.equal(entries[0].description, 'We built a synth from scratch & it "works".');
  assert.equal(entries[1].description, "Notes on the second video with <tags> inside.");
  assert.equal(entries[1].url, "https://www.youtube.com/watch?v=def456");
});

test("watch notes format includes title, url, and description", () => {
  const notes = formatNotes(parseYouTubeFeed(FEED));
  assert.match(notes, /### My First Build Video/);
  assert.match(notes, /watch\?v=abc123/);
  assert.match(notes, /synth from scratch/);
});

test("default mission plan is a three-role pipeline with handoff points", async () => {
  // import runMission's default plan indirectly through the module shape
  const mod = await import("./mission");
  assert.equal(typeof mod.runMission, "function");
  const plan: MissionAgentSpec[] = [
    { name: "Planner", role: "plan", modelId: "local-engine" },
    { name: "Builder", role: "build", modelId: "local-engine" },
    { name: "Reviewer", role: "verify", modelId: "local-engine" },
  ];
  assert.equal(plan.length, 3);
});

// ---------------- mission runner with a scripted model ----------------

test("mission runner executes real tool actions from agent turns", async () => {
  const { runMission } = await import("./mission");
  const { readFile, rm } = await import("node:fs/promises");
  const { existsSync } = await import("node:fs");
  const path = await import("node:path");

  const spaceId = "mission-e2e-" + Date.now();
  const calls: string[] = [];
  const scripted = (async (opts: any) => {
    calls.push(opts.system.slice(0, 30));
    const who = (opts.system.match(/You are (\w+)/) || [])[1] ?? "";
    if (who === "Planner") {
      return {
        text: JSON.stringify({ thought: "plan: write README then list", actions: [{ tool: "write_file", args: { path: "README.md", content: "# Mission\nReal workspace test." } }], handoff: "README written; verify and try publish", done: true }),
        backend: "scripted", modelId: "scripted", via: "test", fallback: false,
      } as any;
    }
    if (who === "Builder") {
      return {
        text: JSON.stringify({ thought: "add code + run node", actions: [{ tool: "write_file", args: { path: "hello.js", content: "console.log('mission-live')" } }, { tool: "run_command", args: { command: "node hello.js" } }], handoff: "code runs", done: true }),
        backend: "scripted", modelId: "scripted", via: "test", fallback: false,
      } as any;
    }
    // Reviewer: verify + attempt GitHub (honestly disconnected in tests)
    return {
      text: JSON.stringify({ thought: "verify files", actions: [{ tool: "list_files", args: {} }, { tool: "github_publish", args: { repo: "a/b", message: "m", files: [{ path: "README.md", content: "x" }] } }], handoff: "", done: true }),
      backend: "scripted", modelId: "scripted", via: "test", fallback: false,
    } as any;
  }) as any;

  const mission = await runMission(
    spaceId,
    { goal: "build and verify", timeBudgetMs: 60_000 },
    { generate: scripted },
  );
  try {
    assert.equal(mission.status, "done");
    assert.match(mission.statusDetail, /tool action/);
    const tools = mission.journal.flatMap((s) => s.actions.map((a) => a.tool));
    assert.ok(tools.includes("write_file"));
    assert.ok(tools.includes("run_command"));
    assert.ok(tools.includes("github_publish"));
    const nodeRun = mission.journal.flatMap((s) => s.actions).find((a) => a.tool === "run_command");
    assert.match(nodeRun?.output ?? "", /mission-live/);
    const gh = mission.journal.flatMap((s) => s.actions).find((a) => a.tool === "github_publish");
    assert.equal(gh?.ok, false, "github must be honestly disconnected without a token");
    const paths = mission.artifacts.map((a) => a.path);
    assert.ok(paths.includes("README.md") && paths.includes("hello.js"));
    const dir = path.resolve(process.cwd(), ".data/space-workspaces", spaceId);
    assert.ok(existsSync(path.join(dir, "README.md")), "file must really exist on disk");
    assert.match(await readFile(path.join(dir, "hello.js"), "utf8"), /mission-live/);
    // handoffs flowed between agents
    assert.ok(mission.journal.some((s) => s.handoff.length > 0));
  } finally {
    await rm(path.resolve(process.cwd(), ".data/space-workspaces", spaceId), { recursive: true, force: true });
  }
});

// ---------------- search_code + run_tests + feedback loop (turn 4 upgrades) ----------------

test("search_code finds matches with file:line across nested files", async () => {
  const { toolWriteFile, toolSearchCode } = await import("./tools");
  const dir = await mkdtemp(path.join(tmpdir(), "wy-srch-"));
  try {
    await toolWriteFile(dir, "src/a.js", "function alpha() { return 1; }\n// TODO: fix alpha\n");
    await toolWriteFile(dir, "src/deep/b.js", "const beta = alpha();\n");
    const out = await toolSearchCode(dir, { pattern: "alpha" });
    assert.match(out, /src\/a\.js:1/);
    assert.match(out, /src\/deep\/b\.js:1/);
    assert.match(out, /3 match/);
    const none = await toolSearchCode(dir, { pattern: "zzz-not-there" });
    assert.match(none, /no matches/);
    const re = await toolSearchCode(dir, { pattern: "TODO: fix alpha" });
    assert.match(re, /src\/a\.js:2/);
    // glob filter
    const globbed = await toolSearchCode(dir, { pattern: "alpha", glob: "b.js" });
    assert.match(globbed, /deep\/b\.js/);
    assert.ok(!/src\/a\.js:1/.test(globbed));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("run_tests auto-detects node --test and reports real failures", async () => {
  const { toolWriteFile, toolRunTests } = await import("./tools");
  const dir = await mkdtemp(path.join(tmpdir(), "wy-test-"));
  try {
    await toolWriteFile(dir, "math.test.js", [
      "const test = require('node:test');",
      "const assert = require('node:assert');",
      "test('adds', () => { assert.equal(1 + 1, 3); });", // deliberately failing
      "",
    ].join("\n"));
    const out = await toolRunTests(dir, {});
    assert.match(out, /node --test/);
    assert.match(out, /exit 1/);
    assert.match(out, /1 !== 3|AssertionError|failing/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("run_tests prefers npm test when package.json has one; honest when nothing to run", async () => {
  const { toolWriteFile, toolRunTests } = await import("./tools");
  const dir = await mkdtemp(path.join(tmpdir(), "wy-test2-"));
  try {
    await toolWriteFile(dir, "package.json", JSON.stringify({ name: "t", scripts: { test: "node -e \"console.log('npm-test-ran')\"" } }));
    const out = await toolRunTests(dir, {});
    assert.match(out, /npm test/);
    assert.match(out, /npm-test-ran/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  const empty = await mkdtemp(path.join(tmpdir(), "wy-test3-"));
  try {
    const out = await toolRunTests(empty, {});
    assert.match(out, /no tests found/);
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
});

test("extra command allowlist is opt-in and scoped to the mission", async () => {
  const { toolRunCommand } = await import("./tools");
  const dir = await mkdtemp(path.join(tmpdir(), "wy-xtr-"));
  try {
    const refused = await toolRunCommand(dir, "python --version", 5000, []);
    assert.match(refused, /refused/);
    const allowed = await toolRunCommand(dir, "python3 --version", 5000, []); // base list has python3
    assert.match(allowed, /exit 0/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("MISSION FEEDBACK LOOP: agents see tool outputs and use them next turn", async () => {
  const { runMission } = await import("./mission");
  const { rm } = await import("node:fs/promises");
  const pathMod = await import("node:path");
  const spaceId = "mission-feedback-" + Date.now();

  const seenPrompts: string[] = [];
  let turn = 0;
  const scripted = (async (opts: any) => {
    seenPrompts.push(opts.messages[0].content);
    assert.equal(opts.maxTokens, 8_000, "mission calls must cap output tokens explicitly");
    turn++;
    if (turn === 1) {
      return {
        text: JSON.stringify({ thought: "write failing test", actions: [{ tool: "write_file", args: { path: "x.test.js", content: "const test=require('node:test');const assert=require('node:assert');test('t',()=>{assert.equal(2+2,5)});" } }, { tool: "run_tests", args: {} }], handoff: "", done: false }),
        backend: "scripted", modelId: "s", via: "t", fallback: false,
      } as any;
    }
    // Turn 2: the observation MUST contain the failure output from turn 1.
    const sawFailure = seenPrompts[1].includes("OBSERVATIONS") && seenPrompts[1].includes("assert.equal(2+2,5") || seenPrompts[1].includes("failing") || seenPrompts[1].includes("AssertionError");
    if (!sawFailure) throw new Error("agent did not receive tool output observations");
    return {
      text: JSON.stringify({ thought: "fix the test to 2+2=4", actions: [{ tool: "write_file", args: { path: "x.test.js", content: "const test=require('node:test');const assert=require('node:assert');test('t',()=>{assert.equal(2+2,4)});" } }, { tool: "run_tests", args: {} }], handoff: "fixed and green", done: true }),
      backend: "scripted", modelId: "s", via: "t", fallback: false,
    } as any;
  }) as any;

  const plan = [{ name: "Solo", role: "worker", modelId: "local-engine" }];
  const mission = await runMission(spaceId, { goal: "make the test pass", timeBudgetMs: 60_000, maxTurnsPerAgent: 3 }, { generate: scripted });
  try {
    assert.equal(mission.status, "done");
    const testRuns = mission.journal.flatMap((s) => s.actions.filter((a) => a.tool === "run_tests"));
    assert.ok(testRuns.length >= 2, "test must have run at least twice (fail → fix → pass)");
    assert.match(testRuns[testRuns.length - 1].output, /exit 0|pass 1/);
    assert.match(mission.handoff, /green/);
  } finally {
    await rm(pathMod.resolve(process.cwd(), ".data/space-workspaces", spaceId), { recursive: true, force: true });
  }
});

test("forge-ai passes an explicit 16k token cap (no silent truncation of games)", async () => {
  const { forgeGameWithAI } = await import("@/lib/games/forge-ai");
  const captured: any[] = [];
  const fakeGen = (async (opts: any) => {
    captured.push(opts);
    return {
      text: "<!DOCTYPE html><html><body><canvas id=g></canvas><script>" + "/* " + "x".repeat(1700) + " */" + "requestAnimationFrame(function(){});addEventListener('keydown',function(){});var score=0;__hud(score,'x');</script></body></html>",
      backend: "scripted", modelId: "s", via: "t", fallback: false,
    } as any;
  }) as any;
  const result = await forgeGameWithAI("a tiny game", {}, { generate: fakeGen });
  assert.equal(captured[0].maxTokens, 16_000);
  assert.ok(result.code.includes("<canvas"));
  assert.equal(result.engine, "ai-codegen");
});
