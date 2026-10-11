/**
 * The 16 AI-assisted mixing workflows. A workflow is a prompt contract, not
 * a canned outcome: each states its focus, whether it is expected to emit a
 * proposal (changes) or only analysis (words), and the exact user-facing
 * label shown in the AI studio. The proposal validator remains the
 * authority over anything a model returns — workflows never bypass it.
 */

export type WorkflowExpectation = "analysis" | "proposal";

export type AiWorkflow = {
  id: string;
  label: string;
  description: string;
  expectation: WorkflowExpectation;
  /** Focus instructions appended to the provider prompt. */
  promptFocus: string;
};

export const AI_WORKFLOWS: readonly AiWorkflow[] = [
  {
    id: "analyze-mix",
    label: "Analyze the mix",
    description: "Read the measured packet and describe the overall balance, dynamics and stereo picture.",
    expectation: "analysis",
    promptFocus:
      "Describe the overall mix: loudness, dynamics, spectral balance and stereo image. State only conclusions the measurements support and label inference as inference.",
  },
  {
    id: "diagnose-channel",
    label: "Diagnose a channel",
    description: "Explain what is measurably wrong with one channel (level, tone, dynamics).",
    expectation: "analysis",
    promptFocus:
      "Diagnose the selected channel using its measurements and the mix context. Name specific numbers as evidence.",
  },
  {
    id: "explain-problem",
    label: "Explain a problem",
    description: "Take a finding (hum, clipping, mud…) and explain cause and repair options.",
    expectation: "analysis",
    promptFocus:
      "Explain the reported problem in plain words: what it is, how the numbers show it, and which real processors could address it.",
  },
  {
    id: "clean-up",
    label: "Clean up",
    description: "Propose removal processors (notch, high-pass) for measured defects.",
    expectation: "proposal",
    promptFocus:
      "Propose cleanup inserts (notch for measured hum, high-pass for rumble/DC). Only propose a processor when a measurement justifies it.",
  },
  {
    id: "balance",
    label: "Balance levels",
    description: "Propose channel-strip fader/pan changes for a better balance.",
    expectation: "proposal",
    promptFocus:
      "Propose channel-strip changes (faderDb, pan) to improve balance. Reference the measured levels per channel.",
  },
  {
    id: "fix-low-end",
    label: "Fix the low end",
    description: "Propose high-pass/low-shelf style inserts to tighten bass.",
    expectation: "proposal",
    promptFocus:
      "Address low-end problems with high-pass and eq-band inserts. Cite the sub/low band measurements.",
  },
  {
    id: "fix-harshness",
    label: "Fix harshness",
    description: "Propose cuts in the measured harshness regions.",
    expectation: "proposal",
    promptFocus:
      "Reduce harshness with eq-band cuts where highMid energy is elevated. Cite the measured bands.",
  },
  {
    id: "vocal-clarity",
    label: "Vocal clarity",
    description: "Propose presence/sibilance treatment for the lead channel.",
    expectation: "proposal",
    promptFocus:
      "Improve vocal clarity with high-pass plus a presence lift or de-esser cut. Justify frequencies from the measurements.",
  },
  {
    id: "stereo-image",
    label: "Stereo image",
    description: "Propose width/pan changes based on correlation and imbalance measurements.",
    expectation: "proposal",
    promptFocus:
      "Improve the stereo image using the measured correlation, width and imbalance. width and channel-strip pan are available.",
  },
  {
    id: "headroom",
    label: "Create headroom",
    description: "Propose gain staging so the master has honest headroom.",
    expectation: "proposal",
    promptFocus:
      "Create headroom before the master using gain/channel-strip changes. Reference measured peaks and LUFS.",
  },
  {
    id: "prepare-mastering",
    label: "Prepare for mastering",
    description: "Propose the pre-master chain (cleanup, balance, dynamics).",
    expectation: "proposal",
    promptFocus:
      "Prepare the mix for mastering: propose a minimal chain of real processors with reasons tied to the measurements.",
  },
  {
    id: "master",
    label: "Master",
    description: "Propose a master-chain (EQ, saturation, soft ceiling) with measured targets.",
    expectation: "proposal",
    promptFocus:
      "Propose master-chain inserts toward the loudness target. Use softclip with an explicit ceilingDb and justify every stage with measurements.",
  },
  {
    id: "chorus-hit-harder",
    label: "Make the chorus hit harder",
    description: "Propose compression/level changes for more impact.",
    expectation: "proposal",
    promptFocus:
      "Make the chorus hit harder using compressor settings and channel level changes. Explain the attack/release choices.",
  },
  {
    id: "darker",
    label: "Make it darker",
    description: "Propose gentle high-end reduction.",
    expectation: "proposal",
    promptFocus: "Darken the tone using eq-band cuts or a low-pass. Cite the high/air band measurements.",
  },
  {
    id: "wider",
    label: "Make it wider",
    description: "Propose stereo widening within mono-compatibility limits.",
    expectation: "proposal",
    promptFocus:
      "Widen the stereo image with the width processor and/or channel-strip pan. Check the measured correlation first and stay mono-safe.",
  },
  {
    id: "vocal-forward",
    label: "Vocal more forward",
    description: "Propose level/presence changes to bring the vocal forward.",
    expectation: "proposal",
    promptFocus:
      "Bring the vocal forward with channel level and presence eq-band changes. Reference the measured vocal level versus the mix.",
  },
] as const;

export const AI_WORKFLOW_IDS = new Set(AI_WORKFLOWS.map((workflow) => workflow.id));

export function findWorkflow(id: string): AiWorkflow | null {
  return AI_WORKFLOWS.find((workflow) => workflow.id === id) ?? null;
}
