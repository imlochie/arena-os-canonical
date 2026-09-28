import { redirect } from "next/navigation";

export default function LegacyWaveyardModerationRedirect() {
  redirect("/waveyard/moderation");
}
