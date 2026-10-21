#!/usr/bin/env node
/**
 * SCRIPTED local model runtime for Spaces acceptance.
 *
 * Speaks the OpenAI-compatible /v1/chat/completions shape that Arena's
 * TurboAgent provider calls. Every response is a fixed, scripted JSON action
 * contract — this is NOT a language model and proves nothing about model
 * intelligence. It exists so the mission loop's real provider routing,
 * tool execution, artifact capture and persistence can be exercised
 * deterministically with no egress and no keys.
 */
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";

const PORT = Number(process.env.SCRIPTED_MODEL_PORT ?? 4317);
const LOG = process.env.SCRIPTED_MODEL_LOG ?? "/tmp/scripted-model-requests.log";
const calls = new Map();

const server = createServer((req, res) => {
  let body = "";
  req.on("data", chunk => { body += chunk; });
  req.on("end", () => {
    if (req.method !== "POST" || !req.url?.startsWith("/v1/chat/completions")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    let payload = {};
    try { payload = JSON.parse(body); } catch {}
    const model = String(payload.model ?? "unknown");
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    const system = String(messages.find(m => m.role === "system")?.content ?? "");
    const user = String(messages.filter(m => m.role === "user").at(-1)?.content ?? "");
    // The mission prompt names the role; keep one action per agent turn.
    const agent = /(?:You are|Agent:)\s*"?([A-Za-z0-9 _-]{1,40})/i.exec(system)?.[1]?.trim() ?? "agent";
    const key = `${model}:${agent}`;
    const call = (calls.get(key) ?? 0) + 1;
    calls.set(key, call);
    const safe = agent.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "agent";
    const file = `acceptance/${safe}-turn-${call}.md`;
    const content = `# Scripted ${agent} turn ${call}\n\nmodel=${model}\n\nThis file was written by the mission tool executor from a scripted\nOpenAI-compatible response, not by a language model.\n`;
    const reply = JSON.stringify({
      thought: `Scripted acceptance response for ${agent} (turn ${call}); no model reasoning.`,
      actions: [{ tool: "write_file", args: { path: file, content } }],
      handoff: "",
      done: true,
    });
    appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), model, agent, call, userChars: user.length, file }) + "\n");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: `scripted-${Date.now()}`,
      object: "chat.completion",
      model,
      choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      scripted: true,
    }));
  });
});
server.listen(PORT, "127.0.0.1", () => {
  console.log(`[scripted-model] listening on http://127.0.0.1:${PORT} (OpenAI-compatible, scripted, not a model)`);
});
