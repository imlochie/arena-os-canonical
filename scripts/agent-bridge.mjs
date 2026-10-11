#!/usr/bin/env node
/**
 * Agent bridge — wire a real agent (or yourself) into Arena OS.
 *
 *   node scripts/agent-bridge.mjs                       interactive terminal mode
 *   node scripts/agent-bridge.mjs --command "…"         pipe mode: the command
 *                                                       receives the prompt on
 *                                                       stdin; its stdout is
 *                                                       the answer
 *   node scripts/agent-bridge.mjs --once                answer one task, exit
 *
 * Options:
 *   --url http://127.0.0.1:3000   the app (default)
 *   --key <secret>                when ARENA_INTERNAL_API_KEY is set
 *   --name "lochie"               label shown in the hub
 *
 * How it answers: in interactive mode the prompt prints to the terminal and
 * the reply is read until EOF (Ctrl+D) or a lone "." line. In --command mode
 * the whole conversation is piped to the command (an AI agent session can be
 * that command) and its stdout becomes the answer. Every answer is delivered
 * through the app's honest provenance: backend "agent-bridge", never branded
 * as a language model.
 */

import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(`--${name}`);
  return index !== -1 && index + 1 < args.length ? args[index + 1] : null;
};
const APP_URL = (option("url") ?? process.env.ARENA_APP_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const KEY = option("key") ?? process.env.ARENA_INTERNAL_API_KEY ?? "";
const NAME = option("name") ?? "terminal";
const COMMAND = option("command");
const ONCE = args.includes("--once");

const headers = { "Content-Type": "application/json", ...(KEY ? { "x-arena-internal-key": KEY } : {}) };

function renderConversation(messages) {
  return messages
    .map((message) => {
      const label = message.role === "user" ? "REQUEST" : message.role === "system" ? "INSTRUCTIONS" : "PREVIOUS ANSWER";
      return `--- ${label} ---\n${message.content}`;
    })
    .join("\n\n");
}

async function takeTask() {
  const response = await fetch(`${APP_URL}/api/agent-bridge?name=${encodeURIComponent(NAME)}`, { headers });
  if (!response.ok) throw new Error(`bridge poll failed: HTTP ${response.status}`);
  return (await response.json()).task;
}

async function answerTask(task) {
  const prompt = renderConversation(task.messages);
  let answer;
  if (COMMAND !== null) {
    const { spawn } = await import("node:child_process");
    answer = await new Promise((resolve, reject) => {
      const child = spawn(COMMAND, { shell: true, stdio: ["pipe", "pipe", "inherit"] });
      let stdout = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve(stdout) : reject(new Error(`command exited ${code}`))));
      child.stdin.write(prompt);
      child.stdin.end();
    });
  } else {
    process.stdout.write(`\n╭─ Agent bridge task ${task.id}\n${prompt}\n╰─ write your answer (end with EOF/Ctrl+D or a lone "." line):\n`);
    answer = await new Promise((resolve) => {
      const lines = [];
      const rl = createInterface({ input: process.stdin, terminal: false });
      rl.on("line", (line) => {
        if (line.trim() === ".") { rl.close(); return; }
        lines.push(line);
      });
      rl.on("close", () => resolve(lines.join("\n")));
    });
  }
  const response = await fetch(`${APP_URL}/api/agent-bridge/${task.id}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ text: answer, ok: answer.trim() !== "" }),
  });
  if (!response.ok) throw new Error(`bridge answer rejected: HTTP ${response.status}`);
  process.stdout.write(COMMAND !== null ? `✓ answered task ${task.id}\n` : `✓ sent.\n`);
}

process.stdout.write(`Agent bridge → ${APP_URL} (as "${NAME}")\n`);
if (COMMAND !== null) process.stdout.write(`Command mode: ${COMMAND}\n`);
process.on("SIGINT", () => { process.stdout.write("\nbridge stopped\n"); process.exit(0); });

let idle = 0;
for (;;) {
  try {
    const task = await takeTask();
    if (task === null) {
      if (ONCE) { process.stdout.write("no queued tasks\n"); process.exit(0); }
      idle += 1;
      if (idle % 15 === 1) process.stdout.write("waiting for tasks…\n");
      await new Promise((resolve) => setTimeout(resolve, 2000));
    } else {
      idle = 0;
      await answerTask(task);
      if (ONCE) process.exit(0);
    }
  } catch (error) {
    process.stderr.write(`bridge error: ${error instanceof Error ? error.message : String(error)}\n`);
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}
