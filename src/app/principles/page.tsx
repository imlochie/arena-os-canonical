export const dynamic = "force-dynamic";

export default function PrinciplesPage() {
  return (
    <div className="mx-auto max-w-4xl">
      <div className="text-center">
        <p className="inline-flex items-center gap-2 rounded-full border border-violet-400/30 bg-violet-400/10 px-4 py-1.5 text-xs font-bold text-violet-200">
          📜 AI Use Principles
        </p>
        <h1 className="mx-auto mt-4 text-3xl font-black leading-tight tracking-tight text-white sm:text-4xl">
          Minimal guardrails.{" "}
          <span className="bg-gradient-to-r from-violet-300 to-cyan-300 bg-clip-text text-transparent">
            Maximum transparency.
          </span>
        </h1>
        <p className="mx-auto mt-3 max-w-2xl text-sm leading-relaxed text-slate-300">
          ArenaForge does not add extra moralizing or hidden censorship on top of the models. But
          honest answer: <strong className="text-white">zero restrictions is not possible</strong> —
          and any app that promises it is misleading you. Here is exactly what applies, why, and
          what control you have.
        </p>
      </div>

      <div className="glass mt-6 rounded-2xl p-5">
        <h2 className="text-base font-extrabold text-white">⚖️ Why &quot;no ToS&quot; can&apos;t exist</h2>
        <div className="mt-3 grid gap-2 text-xs leading-relaxed sm:grid-cols-3">
          <div className="rounded-xl bg-white/[0.03] p-3 ring-1 ring-white/5">
            <p className="text-sm font-extrabold text-white">1 · The law still applies</p>
            <p className="mt-1 text-slate-300">
              CSAM, imminent violence, weapons of mass harm, and other illegal content are blocked
              by law in every jurisdiction we operate in. No setting can or will disable that.
            </p>
          </div>
          <div className="rounded-xl bg-white/[0.03] p-3 ring-1 ring-white/5">
            <p className="text-sm font-extrabold text-white">2 · Upstream providers have ToS</p>
            <p className="mt-1 text-slate-300">
              Cloud calls run on Pollinations, Groq, or OpenRouter free tiers. Their abuse
              protections apply to cloud generations. We attach no-train headers, but we cannot
              override their safety systems — and we won&apos;t try to jailbreak them.
            </p>
          </div>
          <div className="rounded-xl bg-white/[0.03] p-3 ring-1 ring-white/5">
            <p className="text-sm font-extrabold text-white">3 · Local ≠ lawless</p>
            <p className="mt-1 text-slate-300">
              Local Mode and on-device AI run on your machine with zero egress — maximum privacy.
              But this app will never help produce illegal content, regardless of where the
              computation happens.
            </p>
          </div>
        </div>
      </div>

      <div className="glass mt-4 rounded-2xl p-5">
        <h2 className="text-base font-extrabold text-white">✅ What we promise instead</h2>
        <div className="mt-3 space-y-2 text-xs leading-relaxed text-slate-300">
          <p className="rounded-xl bg-white/[0.03] p-3 ring-1 ring-white/5">
            <strong className="text-white">No extra censorship layer.</strong> We don&apos;t add
            keyword blocklists, moral lectures, or hidden refusal prompts on top of the models. What
            you get is the model&apos;s own behavior — nothing more restrictive.
          </p>
          <p className="rounded-xl bg-white/[0.03] p-3 ring-1 ring-white/5">
            <strong className="text-white">You stay the curator.</strong> Battles, collabs, and the
            judge give you perspectives — you decide. The app never auto-censors your saved history,
            templates, or games beyond the legal minimums above.
          </p>
          <p className="rounded-xl bg-white/[0.03] p-3 ring-1 ring-white/5">
            <strong className="text-white">Transparency over vibes.</strong> Every generation shows
            its route (via tag): cloud provider, local engine, or on-device AI — so you always know
            whose rules applied.
          </p>
          <p className="rounded-xl bg-white/[0.03] p-3 ring-1 ring-white/5">
            <strong className="text-white">Your data, your control.</strong> Export or erase anything
            anytime in the{" "}
            <a href="/privacy" className="font-bold text-emerald-300 underline">
              Data Protection Center
            </a>
            . Nothing trains on your content, ever.
          </p>
        </div>
      </div>

      <div className="glass mt-4 rounded-2xl p-5">
        <h2 className="text-base font-extrabold text-white">🧭 Fair-use guidance</h2>
        <p className="mt-1 text-xs text-slate-400">
          Keep it legal, don&apos;t harm others, don&apos;t use the arena to mass-generate spam,
          impersonate real people deceptively, or circumvent other services&apos; safety systems.
          Everything else — edgy fiction, sharp debate, weird art, hard questions — is welcome.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <a href="/" className="btn-arena rounded-xl px-5 py-2 text-sm font-extrabold text-white">
            ⚔️ Back to the arena
          </a>
          <a
            href="/privacy"
            className="rounded-xl border border-white/10 bg-white/5 px-5 py-2 text-sm font-bold text-white hover:bg-white/10"
          >
            🛡️ Privacy Center
          </a>
        </div>
      </div>
    </div>
  );
}
