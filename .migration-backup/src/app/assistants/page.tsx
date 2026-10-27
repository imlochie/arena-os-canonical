import AssistantsManager from "@/components/AssistantsManager";

export const dynamic = "force-dynamic";

export default function AssistantsPage() {
  return (
    <div>
      <div className="mb-5">
        <h1 className="text-2xl font-black tracking-tight text-white sm:text-3xl">🧬 My Assistants</h1>
        <p className="mt-1 max-w-2xl text-sm text-slate-300">
          This is the <strong className="text-white">personal</strong> part: design your own AIs with custom
          personalities, each running on a free brain. They plug straight into Direct Chat.
        </p>
      </div>
      <AssistantsManager />
    </div>
  );
}
