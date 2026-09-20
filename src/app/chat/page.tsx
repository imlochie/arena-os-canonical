import DirectChat from "@/components/DirectChat";
import KeysBar from "@/components/KeysBar";

export const dynamic = "force-dynamic";

export default function ChatPage() {
  return (
    <div>
      <div className="mb-5">
        <h1 className="text-2xl font-black tracking-tight text-white sm:text-3xl">💬 Direct Chat</h1>
        <p className="mt-1 text-sm text-slate-300">
          Skip the blind battle — talk straight to any free model or your custom assistants.
        </p>
      </div>
      <div className="mb-4">
        <KeysBar />
      </div>
      <DirectChat />
    </div>
  );
}
