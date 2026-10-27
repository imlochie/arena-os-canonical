import { generate, type ChatMsg, type GenerateOpts, type GenerateResult } from "./ai";
import { getModel } from "./models";
import { NO_TRAIN_HEADERS } from "./privacy";

// True token streaming via the Pollinations OpenAI-compatible SSE endpoint.
// Local Mode streams the on-device answer in chunks (zero egress).
// Falls back to the full non-streaming cascade (which never throws),
// so callers always get at least one chunk.

export type GenerateStreamOpts = GenerateOpts & {
  /** Reports what actually executed for this stream (called exactly once, before the generator finishes). */
  onResult?: (r: GenerateResult) => void;
};

export async function* generateStream(opts: GenerateStreamOpts): AsyncGenerator<string> {
  const { onResult, ...genOpts } = opts;
  const model = getModel(opts.modelId);

  // Local Mode: chunk the local answer so UI streams identically offline.
  if (opts.localOnly) {
    const r = await generate(genOpts);
    onResult?.(r);
    const chunk = 90;
    for (let i = 0; i < r.text.length; i += chunk) {
      yield r.text.slice(i, i + chunk);
      await new Promise((res) => setTimeout(res, 12));
    }
    return;
  }

  // Non-Pollinations targets (local engine, local canvas, WebLLM, TurboAgent)
  // resolve through the honest generate() cascade — single chunk.
  if (model.pollinationsId.startsWith("__")) {
    const r = await generate(genOpts);
    onResult?.(r);
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
    const streamStart = Date.now();

    const reader = res.body.getReader();
    let firstTokenAt = 0;
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
            if (!firstTokenAt) firstTokenAt = Date.now();
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
    onResult?.({
      text: "",
      runtimeLevel: model.level,
      backend: "pollinations",
      provider: "pollinations",
      modelId: model.id,
      via: "pollinations-stream",
      ms: Date.now() - streamStart,
      firstTokenMs: firstTokenAt ? firstTokenAt - streamStart : undefined,
      fallback: false,
    });
  } catch {
    // Fallback: full cascade (BYOK → keyless → GET → offline), one chunk
    const r = await generate(genOpts);
    onResult?.(r);
    yield r.text;
  }
}
