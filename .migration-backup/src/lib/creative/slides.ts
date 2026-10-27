/**
 * Slides — Gamma.app (#6) for a local-first app. A prompt (or any text)
 * becomes a real deck: structured slides, an HTML presentation you can open
 * anywhere, and an editable .pptx (pptxgenjs, fully offline).
 *
 * Inspired by Presenton (Apache-2.0): prompt/doc → deck → PPTX/PDF, themes,
 * drag-edit. Wave 1 ships generation + HTML + PPTX; themes/templates and
 * document-ingestion follow.
 *
 * Honesty: with the Local Engine the deck content is deterministic structural
 * output (clearly labeled); with a real model (Model Hub / BYOK / keyless
 * remote) the content is model output via the normal generate() contract.
 */

import { generate, type ChatMsg } from "@/lib/ai";

export type Slide = { title: string; bullets: string[]; notes?: string };
export type Deck = { title: string; subtitle: string; slides: Slide[]; engine: string; via: string; fallback: boolean };

const MAX_SLIDES = 20;

/** Parse model markdown into slides: "# " titles, "## " or "-" bullets. */
export function deckFromMarkdown(md: string): Pick<Deck, "title" | "subtitle" | "slides"> {
  const lines = md.split(/\r?\n/);
  const slides: Slide[] = [];
  let title = "";
  let subtitle = "";
  let current: Slide | null = null;
  const push = () => {
    if (current && (current.bullets.length > 0 || current.title)) slides.push(current);
    current = null;
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (/^#\s+/.test(line)) {
      push();
      if (!title) title = line.replace(/^#\s+/, "");
      else current = { title: line.replace(/^#\s+/, ""), bullets: [] };
    } else if (/^##\s+/.test(line)) {
      push();
      current = { title: line.replace(/^##\s+/, ""), bullets: [] };
    } else if (/^[-*]\s+/.test(line)) {
      if (!current) current = { title: "", bullets: [] };
      const bullet = line.replace(/^[-*]\s+/, "").replace(/^\[.\]\s*/, "");
      if (bullet.trim()) current.bullets.push(bullet.trim().slice(0, 240));
    } else if (/^[_*](.+)[_*]$/.test(line) && !subtitle && !current) {
      subtitle = line.slice(1, -1);
    } else if (line.length > 2 && !/^[>|`#]/.test(line)) {
      // Prose lines become bullets too — the Local Engine writes ## sections
      // as short prose lines, and those make perfectly good slide content.
      if (!current) current = { title: "", bullets: [] };
      const bullet = line.replace(/\*\*/g, "").replace(/^[>_]|\*_|_$/g, "").trim();
      const boilerplate = bullet.startsWith("\u2699\ufe0f") || bullet === "subtitle sentence" || bullet.startsWith("Reply in plain markdown");
      if (bullet.length > 3 && !boilerplate) current.bullets.push(bullet.slice(0, 240));
    }
  }
  push();
  // First slide may be the deck title alone — fold it into the header.
  if (slides.length > 0 && slides[0].bullets.length === 0 && !title) {
    title = slides[0].title;
    slides.shift();
  }
  return { title: title || "Untitled deck", subtitle, slides: slides.slice(0, MAX_SLIDES) };
}

/** Deterministic local deck — the honest offline floor (never branded as model output). */
export function fallbackDeck(prompt: string, count = 6): Pick<Deck, "title" | "subtitle" | "slides"> {
  const words = prompt.trim().split(/\s+/).filter(Boolean);
  const title = words.slice(0, 8).join(" ") || "New deck";
  const focus = words.slice(0, 5).join(" ") || "the topic";
  const angles = [
    { t: "Why this matters", b: ["The problem in one sentence", "Who feels it, and how much", "What changes if we solve it"] },
    { t: `Where ${focus} stands today`, b: ["Current approach, briefly", "What works", "What hurts"] },
    { t: "The core idea", b: ["One clear sentence", "Why now is the moment", "The smallest testable version"] },
    { t: "How it works", b: ["Step 1 — the inputs", "Step 2 — the mechanism", "Step 3 — the result"] },
    { t: "Proof and numbers", b: ["The evidence we have", "The evidence we still need", "How we will get it"] },
    { t: "Next moves", b: ["This week", "This month", "The first checkpoint"] },
    { t: "Risks, honestly", b: ["What could break", "How we would know", "The fallback plan"] },
    { t: "The ask", b: ["What we need", "What we give back", "The deadline"] },
  ];
  return {
    title: title.charAt(0).toUpperCase() + title.slice(1),
    subtitle: `Generated offline by the Local Engine from: “${prompt.trim().slice(0, 120)}”`,
    slides: angles.slice(0, Math.max(3, Math.min(count, MAX_SLIDES))).map((a) => ({ title: a.t, bullets: [...a.b] })),
  };
}

export async function buildDeck(
  prompt: string,
  opts: { count?: number; keys?: Record<string, string>; modelId?: string } = {},
): Promise<Deck> {
  const count = Math.max(3, Math.min(opts.count ?? 6, MAX_SLIDES));
  const messages: ChatMsg[] = [
    {
      role: "user",
      content:
        `Create a ${count}-slide presentation deck about: ${prompt}\n\n` +
        `Reply in plain markdown only, exactly this shape:\n` +
        `# Deck title\n_subtitle sentence_\n\n` +
        `and then one "## Slide title" section per slide with 2-4 "- " bullets each. ` +
        `No other prose, no code fences.`,
    },
  ];
  const result = await generate(
    { modelId: opts.modelId ?? "local-engine", messages, keys: opts.keys as never, temperature: 0.6 },
  );
  const parsed = deckFromMarkdown(result.text);
  // A model that echoes the format skeleton ("Deck title" / "Slide title")
  // produced no real content — use the structured fallback deck instead.
  const placeholderEcho =
    parsed.slides.length === 0 ||
    (parsed.title === "Deck title" && parsed.slides.every((s) => s.title === "Slide title" || s.bullets.length === 0));
  if (placeholderEcho) {
    const fb = fallbackDeck(prompt, count);
    return { ...fb, engine: result.backend, via: `${result.via ?? "unknown"}+fallback-deck`, fallback: true };
  }
  return { ...parsed, engine: result.backend, via: result.via ?? result.backend, fallback: false };
}

/** Self-contained HTML presentation (no JS deps, arrow keys to navigate). */
export function deckToHtml(deck: Pick<Deck, "title" | "subtitle" | "slides">): string {
  const slide = (s: Slide) =>
    `<section><h2>${esc(s.title)}</h2><ul>${s.bullets.map((b) => `<li>${esc(b)}</li>`).join("")}</ul></section>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(deck.title)}</title>
<style>
:root{color-scheme:dark}
body{margin:0;font-family:ui-sans-serif,system-ui,sans-serif;background:#0b1020;color:#e5e7eb}
header{padding:48px 64px;background:linear-gradient(135deg,#1e1b4b,#312e81)}
header h1{font-size:44px;margin:0 0 8px}
header p{color:#a5b4fc;margin:0}
main{padding:0 64px}
section{display:none;padding:48px 0;border-bottom:1px solid #1f2937}
section.on{display:block}
section h2{font-size:32px;color:#c4b5fd;margin:0 0 20px}
ul{font-size:22px;line-height:1.9;list-style:none;padding:0}
ul li:before{content:"→ ";color:#818cf8}
footer{position:fixed;bottom:16px;right:24px;color:#64748b;font-size:14px}
</style></head><body>
<header><h1>${esc(deck.title)}</h1><p>${esc(deck.subtitle)}</p></header>
<main>${deck.slides.map(slide).join("\n")}</main>
<footer><span id="pos"></span> · ←/→ to move</footer>
<script>
const s=[...document.querySelectorAll("section")];let i=0;
function go(n){i=Math.max(0,Math.min(s.length-1,n));s.forEach((e,j)=>e.classList.toggle("on",j===i));document.getElementById("pos").textContent=(i+1)+" / "+s.length}
addEventListener("keydown",e=>{if(e.key==="ArrowRight"||e.key===" ")go(i+1);if(e.key==="ArrowLeft")go(i-1)});
if(s.length)go(0);
</script></body></html>`;
}

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Real .pptx via pptxgenjs (server-side, offline). */
export async function deckToPptx(deck: Pick<Deck, "title" | "subtitle" | "slides">): Promise<Buffer> {
  const { default: PptxGenJS } = await import("pptxgenjs");
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_16x9";
  pptx.title = deck.title;
  const cover = pptx.addSlide();
  cover.background = { color: "1E1B4B" };
  cover.addText(deck.title, { x: 0.5, y: 2.0, w: 9, h: 1.2, fontSize: 40, bold: true, color: "FFFFFF" });
  cover.addText(deck.subtitle, { x: 0.5, y: 3.2, w: 9, h: 0.6, fontSize: 16, color: "A5B4FC" });
  for (const slide of deck.slides) {
    const s = pptx.addSlide();
    s.addText(slide.title, { x: 0.5, y: 0.4, w: 9, h: 0.8, fontSize: 28, bold: true, color: "312E81" });
    s.addText(slide.bullets.map((b) => ({ text: b, options: { bullet: true } })), {
      x: 0.8, y: 1.4, w: 8.4, h: 3.8, fontSize: 18, color: "1F2937",
    });
    if (slide.notes) s.addNotes(slide.notes);
  }
  const output = (await pptx.write({ outputType: "nodebuffer" })) as Buffer;
  return output;
}
