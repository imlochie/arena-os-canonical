export const dynamic = "force-dynamic";

function Code({ children, title }: { children: string; title?: string }) {
  return (
    <div className="overflow-hidden rounded-xl border border-white/10 bg-black/50">
      {title && (
        <p className="border-b border-white/10 bg-white/[0.03] px-3 py-1.5 font-mono text-[11px] font-bold text-slate-400">
          {title}
        </p>
      )}
      <pre className="scroll-thin overflow-x-auto p-3 font-mono text-xs leading-relaxed text-cyan-100">{children}</pre>
    </div>
  );
}

function Step({ n, title, body }: { n: string; title: string; body: string }) {
  return (
    <div className="flex gap-3 rounded-2xl bg-white/[0.03] p-4 ring-1 ring-white/5">
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-violet-600 to-cyan-500 text-sm font-black text-white">
        {n}
      </span>
      <div>
        <p className="text-sm font-extrabold text-white">{title}</p>
        <p className="mt-1 text-xs leading-relaxed text-slate-300">{body}</p>
      </div>
    </div>
  );
}

export default function GuidePage() {
  return (
    <div className="mx-auto max-w-4xl">
      <div className="text-center">
        <p className="inline-flex items-center gap-2 rounded-full border border-emerald-400/30 bg-emerald-400/10 px-4 py-1.5 text-xs font-bold text-emerald-200">
          📦 The duplication manual
        </p>
        <h1 className="mx-auto mt-4 text-3xl font-black leading-tight tracking-tight text-white sm:text-4xl">
          Can you duplicate the arena for personal, free, high-quality use?{" "}
          <span className="bg-gradient-to-r from-emerald-300 to-cyan-300 bg-clip-text text-transparent">
            Yes — here&apos;s exactly how.
          </span>
        </h1>
        <p className="mx-auto mt-3 max-w-2xl text-sm leading-relaxed text-slate-300">
          The public arena (Chatbot Arena / LMArena) is open-source in spirit: blind pairwise battles + ELO voting.
          Nothing about that requires money. This app <em>is</em> a working duplicate — and below is the blueprint
          so you can run your own copy forever-free.
        </p>
      </div>

      {/* TLDR */}
      <div className="glass mt-6 rounded-2xl p-5">
        <h2 className="text-base font-extrabold text-white">⚡ TL;DR — the 30-second answer</h2>
        <div className="mt-3 grid gap-2 text-sm sm:grid-cols-3">
          {[
            { e: "1️⃣", t: "Duplicate", d: "Clone the pattern: blind battle UI → vote → ELO update. ~200 lines of real logic. The rest is styling." },
            { e: "2️⃣", t: "Stay free", d: "Route all calls through free tiers (Pollinations keyless, Groq/OpenRouter/Gemini free keys, Ollama local). $0/mo is realistic." },
            { e: "3️⃣", t: "Keep quality", d: "Quality = model choice + system prompts + your votes. Free frontier models in 2026 sit within ~55 ELO of paid flagships." },
          ].map((c) => (
            <div key={c.t} className="rounded-xl bg-white/[0.03] p-3 ring-1 ring-white/5">
              <p className="text-lg">{c.e}</p>
              <p className="mt-1 text-sm font-extrabold text-white">{c.t}</p>
              <p className="mt-1 text-xs leading-relaxed text-slate-300">{c.d}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Architecture */}
      <div className="glass mt-5 rounded-2xl p-5">
        <h2 className="text-base font-extrabold text-white">🏗️ The $0 architecture (exactly what this app runs)</h2>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[560px] border-collapse text-xs">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wider text-slate-400">
                <th className="border border-white/10 bg-white/[0.03] px-3 py-2">Layer</th>
                <th className="border border-white/10 bg-white/[0.03] px-3 py-2">What this clone uses</th>
                <th className="border border-white/10 bg-white/[0.03] px-3 py-2">Cost</th>
              </tr>
            </thead>
            <tbody className="text-slate-200">
              {[
                ["UI", "Next.js App Router + Tailwind (this page)", "$0"],
                ["Battle engine", "/api/battles → 2× parallel LLM calls, identities hidden until vote", "$0"],
                ["LLM (default)", "Pollinations free tier — keyless, no signup", "$0"],
                ["LLM (boost)", "Optional BYOK: Groq / OpenRouter free models", "$0"],
                ["LLM (local turbo)", "TurboAgent (MIT) — Qwen2.5-32B at 65k context on one 24GB GPU via its OpenAI-compatible server (🔑 URL)", "$0"],
                ["LLM (fallback)", "Built-in Offline Sage — app never hard-fails", "$0"],
                ["Ratings", "ELO K=32 in Postgres (models + battles tables)", "$0"],
                ["Personas", "assistants table: system prompt + temp + brain", "$0"],
                ["Hosting", "Any free tier (Vercel/Render/Railway) + free Postgres", "$0"],
              ].map((r) => (
                <tr key={r[0]}>
                  <td className="border border-white/10 px-3 py-2 font-bold text-white">{r[0]}</td>
                  <td className="border border-white/10 px-3 py-2">{r[1]}</td>
                  <td className="border border-white/10 px-3 py-2 font-mono font-bold text-emerald-300">{r[2]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Free providers */}
      <div id="local-turbo" className="glass mt-5 scroll-mt-24 rounded-2xl p-5">
        <h2 className="text-base font-extrabold text-white">⚡ Local turbo: run a frontier-size model on your own GPU</h2>
        <p className="mt-2 text-sm leading-relaxed text-slate-300">
          <a href="https://github.com/TurboAgentAI/turboagent" target="_blank" rel="noreferrer" className="font-bold text-amber-300 hover:underline">
            TurboAgent
          </a>{" "}
          (MIT) combines NF4 4-bit weights with TurboQuant KV-cache compression — Qwen2.5-32B runs at{" "}
          <strong className="text-slate-100">65k-token context on a single 24GB GPU</strong>, fully offline. This app
          speaks to its OpenAI-compatible server directly:
        </p>
        <div className="mt-3">
          <Code title="run your own turbo backend">{`pip install "turboagent-ai[server,torch]"
turboagent serve --model Qwen/Qwen2.5-32B-Instruct --port 8000
# then paste http://127.0.0.1:8000 in the 🔑 keys bar (Test button probes it)`}</Code>
        </div>
        <p className="mt-2 text-xs text-slate-400">
          The arena then gains ⚡ TurboAgent 32B / 7B models (local, private, ELO-tracked like everything else). No
          server running? Those models fall back to Offline Sage with a setup hint — nothing ever hard-fails.
        </p>
      </div>

      <div id="free-keys" className="glass mt-5 scroll-mt-24 rounded-2xl p-5">
        <h2 className="text-base font-extrabold text-white">🆓 Free provider menu — quality ranked</h2>
        <p className="mt-1 text-xs text-slate-400">
          All of these have a genuinely usable $0 tier in 2026. This app uses #1 by default; paste keys for the rest in the bar on the Arena page.
        </p>
        <div className="mt-3 space-y-2 text-xs">
          {[
            { n: "Pollinations", q: "★★★★☆", k: "No key needed", d: "Keyless OpenAI-compatible endpoint. Powers this app out of the box. Aliases: openai, mistral, claude, gemini, deepseek, llama, qwen, grok.", hot: true },
            { n: "Groq free tier", q: "★★★★★", k: "Free key", d: "Blazing Llama 3.3 70B. Insane speed, excellent quality. Generous daily limits. Best BYOK upgrade." },
            { n: "OpenRouter :free models", q: "★★★★☆", k: "Free key", d: "Meta/NVIDIA/Qwen free endpoints (e.g. llama-3.3-70b-instruct:free). One key, many models." },
            { n: "Google Gemini free", q: "★★★★☆", k: "Free key", d: "Huge context (1M tokens), great for long docs. Limits vary by project." },
            { n: "Ollama (local)", q: "★★★☆☆", k: "None — your GPU", d: "Fully private, fully offline. Quality depends on your machine. Point this app's API at localhost:11434 to use it." },
            { n: "HuggingFace Inference", q: "★★★☆☆", k: "Free token", d: "Monthly included credits. Great for trying open-weight models before committing." },
          ].map((p) => (
            <div key={p.n} className={`flex flex-col gap-1 rounded-xl p-3 ring-1 sm:flex-row sm:items-center sm:gap-3 ${p.hot ? "bg-violet-600/10 ring-violet-500/40" : "bg-white/[0.03] ring-white/5"}`}>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-extrabold text-white">
                  {p.n} {p.hot && <span className="ml-1 rounded-full bg-violet-600 px-2 py-0.5 text-[10px]">DEFAULT HERE</span>}
                </p>
                <p className="mt-0.5 leading-relaxed text-slate-300">{p.d}</p>
              </div>
              <div className="flex shrink-0 gap-2 sm:flex-col sm:text-right">
                <span className="text-amber-300">{p.q}</span>
                <span className="font-bold text-slate-400">{p.k}</span>
              </div>
            </div>
          ))}
        </div>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <Code title="GET https://text.pollinations.ai/models — list free models">
{`curl https://text.pollinations.ai/models`}
          </Code>
          <Code title="OpenAI-compatible call (what /api/chat does)">
{`POST https://text.pollinations.ai/openai
{ "model": "openai",
  "messages": [{"role":"user","content":"Hi"}] }`}
          </Code>
        </div>
      </div>

      {/* Quality playbook */}
      <div className="glass mt-5 rounded-2xl p-5">
        <h2 className="text-base font-extrabold text-white">🎯 Keeping quality high while paying $0</h2>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {[
            { e: "🧠", t: "Let ELO pick your brain", d: "Run 20–30 blind battles on YOUR real prompts. The leaderboard will reveal which free model fits you — often DeepSeek for code, Claude-forge for writing, GPT-forge for general." },
            { e: "✍️", t: "System prompts > model size", d: "A sharp persona on a free 70B beats a generic prompt on a flagship. Steal the starter assistants, then tune temperature: 0.2–0.4 for code, 0.7–1.0 for creative." },
            { e: "🔀", t: "Cascade: free → free-er", d: "This app's /api/chat tries BYOK → Pollinations OpenAI endpoint → Pollinations GET → openai alias → offline. Copy that cascade and you almost never see an error." },
            { e: "📏", t: "Judge blind, always", d: "Knowing the model biases you. Keep identities hidden until after the vote (this app masks modelAId/modelBId server-side) so quality signal stays honest." },
          ].map((c) => (
            <div key={c.t} className="rounded-xl bg-white/[0.03] p-3 ring-1 ring-white/5">
              <p className="text-lg">{c.e}</p>
              <p className="mt-1 text-sm font-extrabold text-white">{c.t}</p>
              <p className="mt-1 text-xs leading-relaxed text-slate-300">{c.d}</p>
            </div>
          ))}
        </div>
        <div className="mt-3">
          <Code title="src/lib/elo.ts — the entire rating algorithm">
{`expected = 1 / (1 + 10^((eloB - eloA) / 400))
newA = eloA + 32 * (scoreA - expectedA)  // score: win=1 tie=0.5 loss=0`}
          </Code>
        </div>
      </div>

      {/* Duplicate steps */}
      <div className="glass mt-5 rounded-2xl p-5">
        <h2 className="text-base font-extrabold text-white">📦 How to duplicate this setup yourself</h2>
        <div className="mt-3 grid gap-2">
          <Step n="1" title="Copy the pattern, not the servers"
            body="You need 4 things: a prompt box, two parallel LLM calls, a vote handler, and an ELO update. That's the whole arena. Everything else (auth, styling, analytics) is optional garnish." />
          <Step n="2" title="Start keyless with Pollinations"
            body="Point your chat function at https://text.pollinations.ai/openai with an OpenAI-style body. No signup. You now have a free multi-model backend. Add the GET-style endpoint as fallback." />
          <Step n="3" title="Add Postgres (or even SQLite)"
            body="Three tables: models(id, elo, battles, wins), battles(prompt, modelA, modelB, responses, winner), assistants(name, systemPrompt, baseModel). Run drizzle-kit push and you're live." />
          <Step n="4" title="Layer free keys for headroom"
            body="Get free Groq + OpenRouter + Gemini keys, store them user-side (localStorage), and try them before the keyless tier. More quota, same $0." />
          <Step n="5" title="Go local when you want privacy"
            body="Install Ollama, pull llama3.3 or qwen2.5-coder, and add it as one more model in your catalog pointing at http://localhost:11434. Battles between cloud-free and local-free are fascinating." />
          <Step n="6" title="Deploy for $0"
            body="Push to Vercel / Cloudflare Pages / Render free tier with a free Postgres (Neon/Supabase). Set DATABASE_URL, drizzle-kit push, done. Your private arena lives at your own URL." />
        </div>
      </div>

      {/* FAQ */}
      <div className="glass mt-5 rounded-2xl p-5">
        <h2 className="text-base font-extrabold text-white">❓ FAQ</h2>
        <div className="mt-3 space-y-2 text-xs leading-relaxed">
          {[
            { q: "Is it legal to clone the arena concept?", a: "Yes. Pairwise blind comparison + ELO is a public research methodology (LMSYS/Berkeley published it openly). You're not copying their code or brand — you're re-implementing the idea, which is exactly what open research invites." },
            { q: "Will free models really match paid quality?", a: "For most personal work, yes. The 2026 gap between the top open/free models and paid flagships is ~55 ELO (~58% win rate) — noticeable on elite reasoning, invisible on everyday chat, coding help, and writing. Your personal ELO will show you exactly where it matters for you." },
            { q: "What breaks first on $0?", a: "Rate limits during peak hours. That's why this app cascades across providers and ends in an offline fallback instead of an error page. Add one free Groq key and 95% of flakiness disappears." },
            { q: "Can I battle my own assistants against each other?", a: "Almost — today you battle base models in the Arena and chat assistants in Direct Chat. Next upgrade (easy to add): allow assistant-vs-assistant battles by passing each assistant's system prompt into the two battle slots." },
          ].map((f) => (
            <details key={f.q} className="rounded-xl bg-white/[0.03] p-3 ring-1 ring-white/5">
              <summary className="cursor-pointer text-sm font-extrabold text-white">{f.q}</summary>
              <p className="mt-1.5 text-slate-300">{f.a}</p>
            </details>
          ))}
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <a href="/" className="btn-arena rounded-xl px-5 py-2 text-sm font-extrabold text-white">⚔️ Back to the arena</a>
          <a href="/assistants" className="rounded-xl border border-white/10 bg-white/5 px-5 py-2 text-sm font-bold text-white hover:bg-white/10">🧬 Build an assistant</a>
        </div>
      </div>
    </div>
  );
}
