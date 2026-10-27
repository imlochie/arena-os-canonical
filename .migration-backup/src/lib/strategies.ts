// Client-safe: collaboration strategies (no server/db imports).

export interface Strategy {
  id: string;
  name: string;
  emoji: string;
  tagline: string;
  description: string;
  mapsTo: string; // which cognitive-OS layer
  rounds: 1 | 2;
  roles: string[];
  contributorInstruction: string;
  synthesisInstruction: string;
}

export const STRATEGIES: Strategy[] = [
  {
    id: "council",
    name: "Council Synthesis",
    emoji: "🏛️",
    tagline: "Many minds, one best answer",
    description:
      "Each collaborator answers independently from a different angle. A synthesizer then merges the strongest parts into a single best result — no losers, only building blocks.",
    mapsTo: "Workshop + Editor — unfinished ideas stay unfinished until they get interesting",
    rounds: 1,
    roles: ["The Pragmatist", "The Creative", "The Skeptic", "The Simplifier"],
    contributorInstruction:
      "Answer the challenge from your assigned lens. Be specific, opinionated, and concrete. Use markdown. End with a 1-line 'Best idea:' summary of your strongest point.",
    synthesisInstruction:
      "You are the master synthesizer. Merge the collaborator drafts into ONE best answer. Keep the strongest ideas from each (cite who contributed what in a short 'Sources' line), resolve contradictions by picking the better-supported side, cut fluff, and structure with markdown. The output should read as the definitive answer — better than any single draft.",
  },
  {
    id: "debate",
    name: "Debate & Refine",
    emoji: "⚔️",
    tagline: "Drafts → critiques → best-of synthesis",
    description:
      "Round 1: independent drafts. Round 2: each collaborator critiques the others and sharpens its own position. Then synthesis. Maximum thinking passes per challenge.",
    mapsTo: "Instrument for thinking — human intuition ↔ machine synthesis ↔ judgment ↔ refinement",
    rounds: 2,
    roles: ["The Architect", "The Critic", "The Researcher", "The Operator"],
    contributorInstruction:
      "Answer the challenge boldly and concretely with markdown. Take a clear stance — you will be critiqued next round, so make your reasoning explicit and falsifiable.",
    synthesisInstruction:
      "You are the master synthesizer after a debate. You have Round-1 drafts and Round-2 critiques. Produce ONE best answer: keep what survived critique, discard what was refuted, credit contributors briefly, and structure the final with markdown. Be decisive — no 'on the other hand' mush.",
  },
  {
    id: "brainstorm",
    name: "Diverge → Converge",
    emoji: "🌌",
    tagline: "20 wild options → top 3 + plan",
    description:
      "Collaborators generate wide, divergent options without judging. Synthesis converges to the top 3 with trade-offs and a concrete next-step plan.",
    mapsTo: "Workshop — naming, formats, lore, sequencing, publishing strategy",
    rounds: 1,
    roles: ["The Wildcard", "The Strategist", "The Craftsman", "The Audience"],
    contributorInstruction:
      "Generate 5-7 distinct options/angles for this challenge. Go wide: include at least 2 unconventional ideas. One line each with a bold name + why it could work. Do NOT converge or pick winners — that comes later.",
    synthesisInstruction:
      "You are the converger. From all brainstorm options: pick the TOP 3 (ranked, with trade-offs), then give a concrete 'Next 3 steps' action plan for option #1. Use markdown tables/lists. Credit which collaborator sparked each top pick.",
  },
  {
    id: "second-brain",
    name: "Mess → Structure",
    emoji: "🧠",
    tagline: "Dump chaos, get a system back",
    description:
      "Paste half-formed notes, lists, screenshots-as-text, analytics, competing possibilities. Each collaborator structures it through a different lens; synthesis returns one clean operating doc.",
    mapsTo: "Second brain — memory → synthesis → structure → decision support",
    rounds: 1,
    roles: ["The Taxonomist", "The Prioritizer", "The Risk Spotter", "The Simplifier"],
    contributorInstruction:
      "The user dumped messy working memory. Impose structure through your lens: extract entities, group them, rank what matters, flag gaps and contradictions. Output markdown with headings. Assume more mess will come — make your structure extensible.",
    synthesisInstruction:
      "You are the chief-of-staff synthesizer. Merge the structured takes into ONE clean document: TL;DR (3 bullets), Organized sections, Open questions, and Recommended next actions. Markdown, skimmable, no redundant repetition. This becomes the user's external memory for this topic.",
  },
  {
    id: "systems",
    name: "Solution → System",
    emoji: "⚙️",
    tagline: "Build the machine, not the one-off",
    description:
      "Turn a recurring problem into a repeatable machine: workflow, template, taxonomy, checklist, naming convention, automation. Each collaborator designs one layer.",
    mapsTo: "Systems designer — 'how do we make this easier next time?'",
    rounds: 1,
    roles: ["The Workflow Designer", "The Template Maker", "The Automator", "The Guardian"],
    contributorInstruction:
      "Design a REUSABLE SYSTEM for this challenge through your lens (workflow steps / template / automation / quality checklist). Make it copy-paste usable: concrete steps, fields, conventions. One-off advice is a failure — build the machine.",
    synthesisInstruction:
      "You are the systems architect. Merge the designs into ONE operating system: Overview, Workflow (numbered), Template (code block, copy-paste ready), Naming/taxonomy conventions, Checklist, and Automation opportunities. Markdown. It must be usable next time without re-thinking.",
  },
  {
    id: "scenarios",
    name: "Possible Worlds",
    emoji: "🔮",
    tagline: "Prototype futures, then choose",
    description:
      "Each collaborator explores a different scenario or future (e.g. Phase II options, format changes, 20-upload arcs). Synthesis compares them side-by-side and recommends.",
    mapsTo: "Simulation partner — sandbox for possible worlds",
    rounds: 1,
    roles: ["World A: Bold", "World B: Steady", "World C: Weird", "World D: Lean"],
    contributorInstruction:
      "Explore ONE distinct scenario/future for this challenge through your assigned world-lens. Describe: what happens, what it requires, best case, worst case, and who it suits. Be vivid and concrete — this is a prototype of a possible world, not generic advice.",
    synthesisInstruction:
      "You are the scenario synthesizer. Compare all worlds in a markdown table (World | Upside | Cost/Risk | Best for), then give a clear RECOMMENDATION with reasoning and a 'first experiment' to test it cheaply. Decisive, not hedged.",
  },
  {
    id: "signal",
    name: "Signal Finder",
    emoji: "📡",
    tagline: "Many readings, one clear signal",
    description:
      "Throw raw cognitive material at the wall. Each collaborator offers a different interpretation of what you really mean / what matters. Synthesis extracts the signal from the noise.",
    mapsTo: "Editor of your thinking — curate perspectives, keep your judgment",
    rounds: 1,
    roles: ["The Literalist", "The Psychologist", "The Strategist", "The Contrarian"],
    contributorInstruction:
      "Interpret the user's raw material through your lens. Offer: (1) what you think they're REALLY asking/getting at, (2) the 2-3 key signals you see, (3) one sharp question that would clarify everything. Be opinionated — disagreeing perspectives are the point.",
    synthesisInstruction:
      "You are the signal synthesizer. Read all interpretations and extract: The Signal (what this is really about, 2-3 sentences), Competing readings (brief), The question worth answering next, and a proposed sharp reframing of the challenge. Markdown. Help the human curate — don't decide for them, clarify for them.",
  },
];

export function getStrategy(id: string): Strategy {
  return STRATEGIES.find((s) => s.id === id) ?? STRATEGIES[0];
}
