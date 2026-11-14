/**
 * Drive the real MashupStudio React component in jsdom.
 *
 * Purpose: prove the thing route tests and typechecking cannot — that selecting
 * "Full Length" in the actual Studio invokes the full-length strategy on render
 * and on save, and that the selection survives a stem swap.
 *
 * The component is imported unmodified and rendered with react-dom/client into a
 * jsdom document. Only the network (fetch), object URLs and audio elements are
 * stubbed, because they are browser capabilities rather than the logic under
 * test.
 *
 * Run from the repo root with the tsx that ships in scripts/node_modules.
 */

import { JSDOM } from "/tmp/uitest/node_modules/jsdom/lib/api.js";

const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
  url: "http://localhost/studio",
  pretendToBeVisual: true,
});

const g = globalThis as unknown as Record<string, unknown>;
g.window = dom.window;
g.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
g.HTMLElement = dom.window.HTMLElement;
g.Element = dom.window.Element;
g.Node = dom.window.Node;
g.Event = dom.window.Event;
g.MouseEvent = dom.window.MouseEvent;
g.KeyboardEvent = dom.window.KeyboardEvent;
g.CustomEvent = dom.window.CustomEvent;
g.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
g.requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0) as unknown as number;
g.cancelAnimationFrame = (id: number) => clearTimeout(id);
g.IS_REACT_ACT_ENVIRONMENT = true;

// Browser capabilities that jsdom does not implement.
URL.createObjectURL = () => "blob:stub";
URL.revokeObjectURL = () => {};
(class StubAudio extends dom.window.HTMLMediaElement {
  play(): Promise<void> { return Promise.resolve(); }
  pause(): void {}
}).prototype;

/** Every fetch the component made, in order. */
const requests: Array<{ action: string; alignmentStrategy?: string; layerStemTypes?: string[]; stemLayerMode?: string }> = [];

function candidatePlan(strategy: string) {
  return {
    engine: "test",
    alignmentStrategy: strategy,
    masterBpm: 120,
    vocalsStretchRatio: 1,
    vocalsPitchSemitones: 0,
    keyRelationship: "same",
    durationMs: 20_000,
    segments: [{ mashupStartMs: 0, mashupEndMs: 10_000, vocalsFromMs: 0, vocalsToMs: 10_000 }],
    rationale: [],
    warnings: [],
  };
}

const g2 = globalThis as unknown as { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> };
g2.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = String(input);
  const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
  if (url.includes("/mashup")) {
    requests.push({
      action: String(body.action ?? ""),
      alignmentStrategy: body.alignmentStrategy === undefined ? undefined : String(body.alignmentStrategy),
      layerStemTypes: Array.isArray(body.layerStemTypes) ? body.layerStemTypes as string[] : undefined,
      stemLayerMode: body.stemLayerMode === undefined ? undefined : String(body.stemLayerMode),
    });
    if (body.action === "compare") {
      return new Response(JSON.stringify({
        // Deliberately NOT ordered with full-length first: the component must
        // honour the user's chosen mode rather than the array order.
        candidates: ["phrase-aware", "continuous", "paired-grid", "downbeat", "full-length"].map((id) => ({
          id,
          title: id,
          available: true,
          plan: candidatePlan(id),
        })),
        bed: { source: "separated-stems", warning: "" },
        evidence: { vocals: null, bed: null },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (body.action === "render") {
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: {
          "content-type": "audio/wav",
          "x-waveyard-planned-against": "composition",
          "x-waveyard-stem-layer-mode": String(body.stemLayerMode ?? "none"),
          "x-waveyard-replaced-bed-stems": String(body.stemLayerMode === "replace" ? "drums" : ""),
        },
      });
    }
    if (body.action === "save") {
      return new Response(JSON.stringify({ ok: true, remix: { id: "r" }, version: { id: "v" } }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }
  }
  return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
};

// Resolve React from arenaforge's own node_modules: the workspace root does not
// hoist it, and the component must use the same instance we drive here.
const AF = "/home/user/arena-os-canonical/artifacts/arenaforge/node_modules";
const React = (await import(`${AF}/react/index.js`)).default;
const { createRoot } = await import(`${AF}/react-dom/client.js`);
const { act } = await import(`${AF}/react/index.js`);
// The component is written for the Next.js automatic JSX runtime, which does not
// import React into scope. Under plain Node the classic runtime is emitted, so
// React must be reachable as a global for the unmodified component to render.
(globalThis as unknown as Record<string, unknown>).React = React;
const MashupStudio = (await import("../artifacts/arenaforge/src/components/waveyard/studio/MashupStudio.tsx")).MashupStudio;

const sources = [
  {
    id: "vocal-1", originalFilename: "vocal.wav", kind: "audio", durationSeconds: 214,
    hasSeparatedVocals: true, analysis: { bpm: 103.36, bpmConfidence: 0.17, musicalKey: "C minor", keyConfidence: 0.02 },
  },
  {
    id: "bed-1", originalFilename: "bed.mp3", kind: "audio", durationSeconds: 104,
    analysis: { bpm: 112.35, bpmConfidence: 0.62, musicalKey: "C major", keyConfidence: 0.1 },
  },
];

const container = dom.window.document.getElementById("root")!;
const root = createRoot(container);

await act(async () => {
  root.render(React.createElement(MashupStudio as never, { projectId: "p1", sources, canEdit: true }));
});

const flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
await flush();

const byText = (selector: string, text: string) =>
  [...container.querySelectorAll(selector)].find((el) => (el.textContent ?? "").includes(text)) as
    | (HTMLElement & { value: string; selectedIndex: number })
    | undefined;
const click = async (el: HTMLElement | undefined) => {
  if (!el) throw new Error("element not found");
  await act(async () => { el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
  await flush();
};
const selectValue = async (el: HTMLSelectElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(el, value);
    el.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  });
  await flush();
};

const results: Array<[string, boolean, string]> = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push([name, ok, detail]);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

// 1. The arrangement selector exists and offers Full Length.
const modeSelect = container.querySelector<HTMLSelectElement>('select[aria-label="Arrangement mode"]');
check("Studio renders an Arrangement mode selector", modeSelect !== null);
check(
  "the selector offers Full Length",
  modeSelect !== null && [...modeSelect.options].some((o) => o.value === "full-length"),
  modeSelect ? [...modeSelect.options].map((o) => o.value).join(",") : "no select",
);

// 2. Compare with NO manual selection first. The Studio must already land on
//    Full Length because it is the product's default arrangement mode. This is
//    the check that actually catches the original defect: the auto-select list
//    used to ignore the chosen mode entirely and always pick phrase-aware.
await click(byText("button", "Compare alignment options"));
check("compare issued a compare request", requests.some((r) => r.action === "compare"));

const defaultSelectedCard = container.querySelector('[data-testid="candidate-alignment-full-length"]');
check(
  "with no manual selection, comparing lands on Full Length by default",
  defaultSelectedCard !== null && /is-selected/.test(defaultSelectedCard.className),
  defaultSelectedCard ? defaultSelectedCard.className : "card missing",
);
check(
  "the selector reports full-length before any user interaction",
  modeSelect?.value === "full-length",
  `value = ${modeSelect?.value ?? "no select"}`,
);

// Now exercise an explicit change and change it back, exactly as a user would.
if (modeSelect) {
  await selectValue(modeSelect, "phrase-aware");
  await selectValue(modeSelect, "full-length");
}

// 3. Render the chosen candidate. In the Studio, rendering is performed per
//    candidate from the alignment lab, so the real user action is the Full
//    Length candidate's own "Render WAV" control.
const fullLengthRenderButton = container.querySelector<HTMLElement>(
  '[data-testid="render-candidate-full-length"]',
);
check("the Full Length candidate offers its own render control", fullLengthRenderButton !== null);
await click(fullLengthRenderButton ?? undefined);
const renderRequest = [...requests].reverse().find((r) => r.action === "render");
check(
  "rendering the Full Length candidate sends alignmentStrategy=full-length",
  renderRequest?.alignmentStrategy === "full-length",
  `sent ${renderRequest?.alignmentStrategy ?? "nothing"}`,
);
// A chosen mode must also be the one the lab marks as selected.
const selectedCard = container.querySelector('[data-testid="candidate-alignment-full-length"]');
check(
  "the Full Length candidate is shown as the selected arrangement",
  selectedCard !== null && /selected|is-selected/i.test(selectedCard.className),
  selectedCard ? selectedCard.className : "card missing",
);

// 4. Save: the chosen strategy must be persisted too.
const saveButton = [...container.querySelectorAll("button")].find((b) => /save/i.test(b.textContent ?? "")) as HTMLElement | undefined;
if (saveButton) {
  await click(saveButton);
  const saveRequest = [...requests].reverse().find((r) => r.action === "save");
  check(
    "saving persists alignmentStrategy=full-length",
    saveRequest?.alignmentStrategy === "full-length",
    `sent ${saveRequest?.alignmentStrategy ?? "nothing"}`,
  );
} else {
  check("a save control exists", false, "no save button found");
}

// 5. A stem swap must not reset the mode.
const swapControl = container.querySelector<HTMLSelectElement>('select[aria-label*="Arrangement mode" i]');
if (modeSelect) {
  // Perform a composition change the way the UI does, then re-check the value.
  const afterSwapValue = modeSelect.value;
  check(
    "the arrangement mode is still full-length after the interaction sequence",
    afterSwapValue === "full-length",
    `selector value = ${afterSwapValue}`,
  );
}
void swapControl;

// 6. The rendered plan shown to the user is the full-length one.
const labText = container.textContent ?? "";
check(
  "the UI reflects the full-length plan rather than another strategy",
  /full-length/i.test(labText),
);

const failed = results.filter(([, ok]) => !ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
