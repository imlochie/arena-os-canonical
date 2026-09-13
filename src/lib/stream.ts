import { generate, type ChatMsg, type GenerateOpts } from "./ai";
import { getModel } from "./models";
import { NO_TRAIN_HEADERS } from "./privacy";

// True token streaming via the Pollinations OpenAI-compatible SSE endpoint.
// Local Mode streams the on-device answer in chunks (zero egress).
// Falls back to the full non-streaming cascade (which never throws),
// so callers always get at least one chunk.

export async function* generateStream(opts: GenerateOpts): AsyncGenerator<string> {
  const model = getModel(opts.modelId);

  // Local Mode: chunk the local answer so UI streams identically offline.
  if (opts.localOnly) {
    const r = await generate(opts);
    const chunk = 90;
    for (let i = 0; i < r.text.length; i += chunk) {
      yield r.text.slice(i, i + chunk);
      await new Promise((res) => setTimeout(res, 12));
    }
    return;
  }

  // Image + offline models resolve instantly — single chunk
  if (model.pollinationsId.startsWith("__image__") || model.pollinationsId === "__offline__") {
    const r = await generate(opts);
    yield r.text;
    return;
  }

  const temperature = opts.temperature ?? 0.7;
  const system = opts.system?.trim();
  const fullMessages: ChatMsg[] = system
    ? [{ role: "system", content: system }, ...opts.messages.filter((m) => m.role !== "system")]
    : opts.messages;

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 75000);
    const res = await fetch("https://text.pollinations.ai/openai", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...NO_TRAIN_HEADERS },
      body: JSON.stringify({
        model: model.pollinationsId,
        messages: fullMessages,
        temperature,
        stream: true,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok || !res.body) throw new Error(`stream status ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let yielded = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split("\n");
      buf = parts.pop() ?? "";
      for (const line of parts) {
        const t = line.trim();
        if (!t.startsWith("data:")) continue;
        const payload = t.slice(5).trim();
        if (payload === "[DONE]") continue;
        try {
          const json = JSON.parse(payload);
          const delta: string =
            json?.choices?.[0]?.delta?.content ?? json?.choices?.[0]?.message?.content ?? "";
          if (delta) {
            yielded = true;
            yield delta;
          }
        } catch {
          /* ignore partial JSON */
        }
      }
    }
    clearTimeout(timer);
    if (!yielded) throw new Error("empty stream");
  } catch (error) {
    if (opts.strictRoute) throw error;
    // Legacy callers retain the compatibility cascade. Assigned-worker calls
    // fail explicitly so a fallback can only happen through a new assignment.
    const r = await generate(opts);
    yield r.text;
  }
}
