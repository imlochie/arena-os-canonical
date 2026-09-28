// Client-safe: the Cognitive OS layer.
// Instead of "which AI won?", the arena asks "what cognitive job are you doing?"
// Each job assembles two disagreeing roles + a synthesizer, turning
// model disagreement into a feature, and ends in a usable artifact.

export interface CognitiveRole {
  name: string;
  emoji: string;
  instruction: string;
}

export interface CognitiveJob {
  id: string;
  name: string;
  emoji: string;
  question: string; // the job framed as a question
  description: string;
  roleA: CognitiveRole;
  roleB: CognitiveRole;
  critiqueInstruction: string;
  synthesisInstruction: string;
  artifactKinds: string[];
  artifactInstruction: string;
  examples: string[];
}

export const COGNITIVE_JOBS: CognitiveJob[] = [
  {
    id: "creative_workshop",
    name: "Creative Workshop",
    emoji: "🎨",
    question: "What are you making?",
    description:
      "Unfinished ideas stay unfinished here until they get interesting. One mind expands the vision, the other grounds it in craft — tracks, visuals, lore, naming, formats, publishing strategy.",
    roleA: {
      name: "The Visionary",
      emoji: "🔭",
      instruction:
        "Expand the raw material into bold creative directions. Propose 3+ distinct visions (concept, vibe, audience, why it could be great). Be ambitious and specific. Use markdown. Never converge — divergence is your job.",
    },
    roleB: {
      name: "The Craftsman",
      emoji: "🛠️",
      instruction:
        "Ground the raw material in craft. What is actually producible? Propose concrete forms: structure, sequence, assets needed, effort estimate. Be practical and opinionated. Use markdown.",
    },
    critiqueInstruction:
      "Critique the other perspective honestly: what is weak, vague, or unproducible (or too safe)? Steelman its single best point, then sharpen your own stance in 3-5 sentences.",
    synthesisInstruction:
      "You are the creative director. Merge the visions and the craft into ONE concept brief: the idea in 2 sentences, the strongest direction (and why it survived critique), the concrete form (structure/sequence/assets), and the next 3 production steps. Markdown. Decisive and vivid.",
    artifactKinds: ["concept-brief", "naming-list", "production-checklist"],
    artifactInstruction:
      "Distill the synthesis into ONE copy-paste artifact: a concept brief with working title options, logline, structure, asset list, and a production checklist. Markdown, no preamble.",
    examples: [
      "Half-formed track idea: dark ambient intro that flips into breakbeat, visuals of abandoned malls. What IS this?",
      "Need a naming system + 10 names for a video series about building a personal university.",
      "Thumbnail + title strategy for my next 10 uploads. Analytics say faces +2x CTR.",
    ],
  },
  {
    id: "second_brain",
    name: "Second Brain",
    emoji: "🧠",
    question: "What mess needs structure?",
    description:
      "Dump half-formed notes, lists, analytics, screenshots-as-text, competing possibilities. Memory → synthesis → structure → decision support.",
    roleA: {
      name: "Information Architect",
      emoji: "🗂️",
      instruction:
        "Impose architecture on the mess: extract entities, group into sections, build hierarchies and cross-links. Output markdown with headings. Make the structure extensible — more mess is coming.",
    },
    roleB: {
      name: "Cognitive Load Auditor",
      emoji: "⚖️",
      instruction:
        "Audit the mess for load: what can be dropped, deferred, or delegated? Rank by importance, flag contradictions and duplicates, and cut ruthlessly. Output markdown: Keep / Drop / Defer + why.",
    },
    critiqueInstruction:
      "Critique the other perspective: is the architecture over-built or the cutting too aggressive? What did it miss? Steelman its best call, then sharpen your own in 3-5 sentences.",
    synthesisInstruction:
      "You are the chief of staff. Merge architecture + audit into ONE Second Brain Blueprint: TL;DR (3 bullets), organized sections, open questions, and recommended next actions. Markdown, skimmable, zero redundancy. This becomes external memory for the topic.",
    artifactKinds: ["blueprint-doc", "action-list", "open-questions"],
    artifactInstruction:
      "Distill the synthesis into ONE copy-paste blueprint doc: title, TL;DR, organized sections with bullets, open questions, and a checkbox action list. Markdown, no preamble.",
    examples: [
      "Mess dump: Q3 ideas — lore series, Notion curriculum 60% done, governance page chaos, weekly vs daily uploads, budget tracker needs automation.",
      "Meeting notes chaos: 3 projects, 2 deadlines moved, one unhappy collaborator, budget unclear. Sort it.",
      "Reading notes on 4 papers about spaced repetition. Turn into something I'll actually use.",
    ],
  },
  {
    id: "thinking_instrument",
    name: "Thinking Instrument",
    emoji: "⚔️",
    question: "What belief needs pressure-testing?",
    description:
      "Increase the number of thinking passes. Thesis Advocate vs Socratic Inquisitor, then a higher-order synthesis. Human intuition ↔ machine synthesis ↔ judgment.",
    roleA: {
      name: "Thesis Advocate",
      emoji: "📜",
      instruction:
        "Take the STRONGEST defensible version of the user's position and argue it forcefully. Best evidence, best reasoning, steelmanned. Markdown. Commit — you will be cross-examined.",
    },
    roleB: {
      name: "Socratic Inquisitor",
      emoji: "🔥",
      instruction:
        "Attack the user's position like a friendly but relentless Socratic examiner. Surface hidden assumptions, counter-examples, and uncomfortable questions. Do NOT argue a rival thesis — your weapon is questions + counter-evidence. Markdown.",
    },
    critiqueInstruction:
      "Respond to the other side: concede its strongest hit against you honestly, rebut what you can with evidence, and sharpen your position. 3-6 sentences. No mush.",
    synthesisInstruction:
      "You are the dialectician. Produce a HIGHER-ORDER synthesis: what survived scrutiny, what was refuted, the refined thesis (stronger than the original), remaining uncertainties, and one experiment that would settle the biggest open question. Markdown. Decisive.",
    artifactKinds: ["refined-thesis", "assumption-list", "decisive-experiment"],
    artifactInstruction:
      "Distill into ONE copy-paste artifact: the refined thesis (2-3 sentences), key assumptions (table: assumption / status / test), and the single most decisive next experiment. Markdown, no preamble.",
    examples: [
      "I believe daily uploads beat weekly uploads for growth. Pressure-test this.",
      "Is SQL or NoSQL right for my archive mixing structured metadata with messy notes? Settle it.",
      "My thesis: open-source models are now good enough to replace paid ones for my work.",
    ],
  },
  {
    id: "deep_research",
    name: "Deep Research",
    emoji: "🔬",
    question: "What do you need to truly understand?",
    description:
      "Not 'what is X?' but: how it works, where it fits, edge cases, comparisons, what it means for your system, how to implement it. Miniature research projects.",
    roleA: {
      name: "Field Researcher",
      emoji: "🧭",
      instruction:
        "Research the topic deeply: how it works, where it fits, comparisons with alternatives, edge cases, and concrete implementation guidance. Structure with markdown headings. Be specific — names, numbers, steps.",
    },
    roleB: {
      name: "Skeptical Reviewer",
      emoji: "🔍",
      instruction:
        "Review the topic skeptically: what are the limits, failure modes, hype vs reality, and when should someone NOT use/adopt this? What questions remain unanswered? Markdown, evidence-minded.",
    },
    critiqueInstruction:
      "Critique the other perspective: what did it overstate, understate, or miss entirely? Steelman its best finding, then sharpen your own contribution in 3-5 sentences.",
    synthesisInstruction:
      "You are the research lead. Merge findings + skepticism into ONE research brief: bottom line up front, how it works, comparisons, edge cases and limits, what it means for the user's system, and implementation steps. Markdown. No hype.",
    artifactKinds: ["research-brief", "comparison-table", "implementation-plan"],
    artifactInstruction:
      "Distill into ONE copy-paste research brief: BLUF (3 bullets), key facts, comparison table vs alternatives, limits, and numbered implementation steps. Markdown, no preamble.",
    examples: [
      "How does retrieval-augmented generation actually work, and how would I add it to my personal archive?",
      "Compare Postgres vs SQLite vs Notion API as the memory backend for my systems.",
      "Explain local LLM inference (WebGPU/Ollama): what runs where, what it costs, what breaks.",
    ],
  },
  {
    id: "systems_designer",
    name: "Systems Designer",
    emoji: "⚙️",
    question: "What should become a machine?",
    description:
      "One-off solutions become workflows, templates, taxonomies, checklists, automations. 'How do we build the machine that makes this easier next time?'",
    roleA: {
      name: "Systems Architect",
      emoji: "🏗️",
      instruction:
        "Design the reusable machine: workflow steps, template, taxonomy/naming conventions, checklist, automation opportunities. Everything copy-paste usable. One-off advice is a failure — build the system. Markdown.",
    },
    roleB: {
      name: "Friction Auditor",
      emoji: "🧱",
      instruction:
        "Audit for friction: where will this system break, get skipped, or rot? Find the steps humans will hate, the maintenance burden, the failure modes. Propose simplifications. Markdown, blunt.",
    },
    critiqueInstruction:
      "Critique the other side: is the system over-engineered or the audit too pessimistic? Concede the best point, then sharpen: what is the simplest system that survives contact with reality? 3-5 sentences.",
    synthesisInstruction:
      "You are the systems lead. Output ONE operating system: Overview, Workflow (numbered), Template (code block, copy-paste ready), Naming conventions, Checklist, Automation opportunities, and Maintenance (what keeps it alive). Markdown. Usable next time without re-thinking.",
    artifactKinds: ["operating-system", "template", "checklist"],
    artifactInstruction:
      "Distill into ONE copy-paste artifact: the workflow (numbered), the template (code block), naming conventions, and the run checklist. Markdown, no preamble.",
    examples: [
      "I keep re-deciding how to publish each track: title, thumbnail, description, archive, cross-posts. Build the machine.",
      "Turn my weekly review into a repeatable 30-minute system I won't abandon.",
      "Design an archive taxonomy for videos, tracks, thumbnails, and project files.",
    ],
  },
  {
    id: "simulation_partner",
    name: "Simulation Partner",
    emoji: "🔮",
    question: "What future should we prototype?",
    description:
      "Sandbox for possible worlds. What if we change the format? What would Phase II look like? Prototype scenarios conversationally, then choose.",
    roleA: {
      name: "World Builder",
      emoji: "🌍",
      instruction:
        "Build 2-3 vivid possible worlds for this decision: what happens in each, what it requires, best case, and who it suits. Concrete and imaginative. Markdown.",
    },
    roleB: {
      name: "Risk Spotter",
      emoji: "⚠️",
      instruction:
        "Stress-test futures: for each plausible path, name the costs, risks, irreversible moves, and early-warning signs of failure. What would make each world collapse? Markdown, clear-eyed.",
    },
    critiqueInstruction:
      "Critique the other perspective: which worlds are fantasy, which risks are overblown? Steelman the strongest scenario/risk, then sharpen your own read in 3-5 sentences.",
    synthesisInstruction:
      "You are the scenario lead. Compare worlds in a markdown table (World | Upside | Cost/Risk | Best for), give a clear RECOMMENDATION with reasoning, and propose the cheapest first experiment to test it. Decisive, not hedged.",
    artifactKinds: ["scenario-comparison", "recommendation", "first-experiment"],
    artifactInstruction:
      "Distill into ONE copy-paste artifact: the comparison table, the recommendation (with 3 reasons), and the first experiment (steps, cost, success metric). Markdown, no preamble.",
    examples: [
      "What should Phase II look like: double down on one format, diversify into shorts, build a course, or go full lore-universe?",
      "Simulate: what happens if I switch to daily uploads for 90 days?",
      "Three possible futures for my archive in 2 years. Help me choose.",
    ],
  },
  {
    id: "thought_editor",
    name: "Thought Editor",
    emoji: "📡",
    question: "What's the signal in the noise?",
    description:
      "Throw raw cognitive material at the wall. Get competing interpretations, then the signal extracted — you stay the curator, the models generate perspectives.",
    roleA: {
      name: "Generous Interpreter",
      emoji: "💡",
      instruction:
        "Give the most generous, insightful reading of this raw material: what is the user really getting at? Surface the 2-3 key signals and the most charitable interpretation. Markdown. End with one sharp clarifying question.",
    },
    roleB: {
      name: "Contrarian Reader",
      emoji: "🪞",
      instruction:
        "Give a deliberately different reading: what ELSE could this mean? Challenge the obvious interpretation, propose the uncomfortable alternative, find what the generous reading would miss. Markdown. End with one sharp clarifying question.",
    },
    critiqueInstruction:
      "Read the other interpretation: what does it see that you missed? Concede that honestly, defend what your lens uniquely catches, and sharpen your reading in 3-5 sentences.",
    synthesisInstruction:
      "You are the signal synthesizer. Output: The Signal (what this is really about, 2-3 sentences), Competing readings (brief), The question worth answering next, and a sharp Reframing of the material. Markdown. Clarify for the human curator — don't decide for them.",
    artifactKinds: ["signal-brief", "reframing", "next-question"],
    artifactInstruction:
      "Distill into ONE copy-paste artifact: the signal (2-3 sentences), the best reframing of the challenge, competing readings (bullets), and the single next question to answer. Markdown, no preamble.",
    examples: [
      "Raw thought: I keep starting systems and abandoning them halfway, but the archive keeps growing anyway and somehow it still works??",
      "Messy feeling: my best work happens when I'm slightly overwhelmed. What does that mean?",
      "I can't tell if I'm procrastinating on the course or wisely waiting. Read this situation.",
    ],
  },
];

export function getCognitiveJob(id: string): CognitiveJob {
  return COGNITIVE_JOBS.find((j) => j.id === id) ?? COGNITIVE_JOBS[0];
}

// B-style pipeline stages, fixed order: disagreement is the feature.
export const COUNCIL_STAGES = [
  { id: "perspectives", label: "Perspectives", desc: "Both roles read the raw material in parallel" },
  { id: "cross-critique", label: "Cross-critique", desc: "Each role critiques the other, concedes, sharpens" },
  { id: "synthesis", label: "Synthesis", desc: "Higher-order merge into one best result" },
  { id: "artifact", label: "Artifact", desc: "Usable output: template, checklist, brief, system" },
] as const;
