/** Declarative, untrusted test data: never eval model-authored test programs.
 * These checks observe visible game-reported state after real browser inputs.
 * They are not an independent proof of arbitrary prompt fidelity or game quality.
 */
import type { Frame } from "playwright-core";
import { createHash } from "node:crypto";

export const GAMEPLAY_SCOPE = "Declared gameplay scenarios: visible HUD/state and canvas observations after real browser inputs. Not arbitrary prompt fidelity, hidden physics correctness, live-model quality or fun.";
export const GAMEPLAY_INSTRUCTIONS = `
Include <script id="arena-gameplay" type="application/json"> containing:
{"version":1,"scenarios":[
 {"kind":"controls","name":"Move the player","steps":[{"press":"ArrowRight"}],"checks":[{"selector":"#position","mode":"change"}]},
 {"kind":"progress","name":"Earn a point","steps":[{"press":"Space"}],"checks":[{"selector":"#score","mode":"increase"}]},
 {"kind":"terminal","name":"Reach the objective","steps":[{"press":"Space"}],"checks":[{"selector":"#state","mode":"equals","value":"won"}]},
 {"kind":"restart","name":"Restart resets progress","steps":[{"press":"Space"},{"press":"r"}],"checks":[{"selector":"#score","mode":"equals","value":"0"},{"selector":"#state","mode":"equals","value":"playing"}]}
]}
This is a FORMAT EXAMPLE, not mechanics to copy. Design four real scenarios for
THIS requested game: controls, progress, terminal, restart. Each starts in a fresh
document AFTER clicking Start/Play if present. Make terminal reachable through
normal input, not a test-only cheat. Restart must exercise a changed state, then
reset it. Use visible, unique #id HUD elements updated from the ACTUAL game state.
Actions: {"press":"ArrowRight","holdMs":100}, {"click":"#button"}, {"waitMs":100}.
Keys: arrows, Space, Enter, Escape, letters a-z. Max 8 steps/scenario, 4 scenarios,
and 2000ms TOTAL explicit wait/hold budget. Selectors must be simple #ids.
Checks: change, increase, decrease, equals (with string value). Controls must
change an observed value and the canvas; progress must increase/decrease a numeric
HUD; terminal must check a visible terminal state; restart must first change the
checked value then restore it. No hidden telemetry, hardcoded success flags, test
backdoors or assertions unrelated to the actual mechanics. Keep the game's real
design; a puzzle or sports game need not acquire shooter mechanics.`;

type Kind = "controls" | "progress" | "terminal" | "restart";
type Step = { press: string; holdMs?: number } | { click: string } | { waitMs: number };
type Check = { selector: string; mode: "change" | "increase" | "decrease" | "equals"; value?: string };
export type GameplayContract = { version: 1; scenarios: { kind: Kind; name: string; steps: Step[]; checks: Check[] }[] };
export type GameplayReport = { scope: string; status: "passed" | "failed"; scenarios: { name: string; kind: Kind; ok: boolean; issues: string[]; before: string[]; after: string[]; canvasChanged: boolean }[] };
const selectorOK = (v: unknown): v is string => typeof v === "string" && /^#[A-Za-z][\w-]{0,63}$/.test(v);
const kinds: Kind[] = ["controls", "progress", "terminal", "restart"];

export function parseGameplayContract(code: string, required = false): GameplayContract | undefined {
  const blocks = [...code.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)]
    .filter(m => /\bid\s*=\s*["']arena-gameplay["']/i.test(m[1]));
  if (!blocks.length && !required) return;
  if (blocks.length !== 1 || !/\btype\s*=\s*["']application\/json["']/i.test(blocks[0][1])) throw new Error("Include exactly one arena-gameplay application/json script with four meaningful scenarios.");
  let raw: GameplayContract;
  try { raw = JSON.parse(blocks[0][2]); } catch { throw new Error("arena-gameplay must contain valid JSON, not executable test code."); }
  if (raw?.version !== 1 || !Array.isArray(raw.scenarios) || raw.scenarios.length !== 4) throw new Error("Gameplay contract version 1 requires four scenarios.");
  let budget = 0;
  const seen = new Set<Kind>();
  for (const scenario of raw.scenarios) {
    if (!scenario || !kinds.includes(scenario.kind) || seen.has(scenario.kind) || typeof scenario.name !== "string" || !scenario.name.trim() || scenario.name.length > 120) throw new Error("Gameplay scenarios need distinct controls/progress/terminal/restart kinds and short names.");
    seen.add(scenario.kind);
    if (!Array.isArray(scenario.steps) || !scenario.steps.length || scenario.steps.length > 8 || !Array.isArray(scenario.checks) || !scenario.checks.length || scenario.checks.length > 4) throw new Error("Each gameplay scenario needs 1–8 actions and 1–4 checks.");
    for (const step of scenario.steps) {
      if (!step || Object.keys(step).some(k => !["press", "holdMs", "click", "waitMs"].includes(k))) throw new Error("Unsupported gameplay action.");
      if ("press" in step && !("click" in step) && !("waitMs" in step) && /^(Arrow(Left|Right|Up|Down)|Space|Enter|Escape|[a-z])$/.test(step.press)) {
        const ms = step.holdMs ?? 0;
        if (!Number.isInteger(ms) || ms < 0 || ms > 500) throw new Error("Gameplay key holds must be 0–500ms.");
        budget += ms;
      } else if ("click" in step && Object.keys(step).length === 1 && selectorOK(step.click)) {
        // Only an element in the opaque game frame; no host/browser API actions.
      } else if ("waitMs" in step && Object.keys(step).length === 1 && Number.isInteger(step.waitMs) && step.waitMs >= 0 && step.waitMs <= 500) budget += step.waitMs;
      else throw new Error("Unsupported gameplay action or selector.");
    }
    for (const check of scenario.checks) {
      if (!check || !selectorOK(check.selector) || !["change", "increase", "decrease", "equals"].includes(check.mode) || (check.mode === "equals" && (typeof check.value !== "string" || check.value.length > 200))) throw new Error("Gameplay checks require unique visible #id observations and bounded values.");
    }
    if (scenario.kind === "controls" && !scenario.checks.some(c => c.mode === "change")) throw new Error("Controls must demonstrate a changed visible value.");
    if (scenario.kind === "progress" && !scenario.checks.some(c => ["increase", "decrease"].includes(c.mode))) throw new Error("Progress must demonstrate a numeric increase/decrease.");
    if (["terminal", "restart"].includes(scenario.kind) && !scenario.checks.some(c => c.mode === "equals")) throw new Error("Terminal/restart scenarios must check their resulting state.");
  }
  if (budget > 2000) throw new Error("Gameplay explicit wait/hold budget exceeds 2000ms.");
  return raw;
}

export async function exerciseGameplay(contract: GameplayContract, reset: () => Promise<Frame>, progress: (phase: string) => void = () => {}): Promise<GameplayReport> {
  const reports: GameplayReport["scenarios"] = [];
  const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");
  for (const scenario of contract.scenarios) {
    const report: GameplayReport["scenarios"][number] = { name: scenario.name, kind: scenario.kind, ok: false, issues: [], before: [], after: [], canvasChanged: false };
    reports.push(report);
    try {
      progress(`${scenario.kind}: fresh document`);
      const frame = await reset();
      const observe = async () => Promise.all(scenario.checks.map(async check => {
        const node = frame.locator(check.selector);
        if (await node.count() !== 1 || !await node.isVisible()) throw new Error(`${check.selector} must identify exactly one visible game-state element.`);
        return (await node.innerText()).trim().slice(0, 201);
      }));
      report.before = await observe();
      const canvas = frame.locator("canvas").first();
      const beforeHash = hash(await canvas.screenshot());
      let changedBeforeRestart = false;
      for (let si = 0; si < scenario.steps.length; si++) {
        progress(`${scenario.kind}: action ${si + 1}/${scenario.steps.length}`);
        const step = scenario.steps[si];
        if ("press" in step) {
          await canvas.focus();
          await frame.page().keyboard.down(step.press);
          if (step.holdMs) await frame.page().waitForTimeout(step.holdMs);
          await frame.page().keyboard.up(step.press);
        } else if ("click" in step) {
          const target = frame.locator(step.click);
          if (await target.count() !== 1) throw new Error("Gameplay action target must be unique.");
          await target.click({ timeout: 500 });
        } else await frame.page().waitForTimeout(step.waitMs);
        // Let real rendering/HUD updates consume input, not test-side state writes.
        await frame.page().waitForTimeout(35);
        if (si < scenario.steps.length - 1) {
          const interim = await observe();
          changedBeforeRestart ||= interim.some((v, i) => v !== report.before[i]);
        }
      }
      report.after = await observe();
      report.canvasChanged = beforeHash !== hash(await canvas.screenshot());
      for (let i = 0; i < scenario.checks.length; i++) {
        const check = scenario.checks[i], a = report.before[i], b = report.after[i];
        const numeric = /^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(a) && /^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(b);
        const ok = check.mode === "equals" ? b === check.value : check.mode === "change" ? b !== a :
          numeric && (check.mode === "increase" ? Number(b) > Number(a) : Number(b) < Number(a));
        if (!ok) report.issues.push(`${check.selector} ${check.mode}: observed ${JSON.stringify(a)} → ${JSON.stringify(b)}${check.mode === "equals" ? `; expected ${JSON.stringify(check.value)}` : ""}.`);
      }
      if (scenario.kind === "controls" && !report.canvasChanged) report.issues.push("Controls changed no observed canvas content.");
      if (scenario.kind === "terminal" && !report.after.some((value, i) => value !== report.before[i])) report.issues.push("Terminal scenario reached no changed observable state.");
      if (scenario.kind === "restart" && !changedBeforeRestart) report.issues.push("Restart did not first exercise a changed game state.");
      report.ok = report.issues.length === 0;
    } catch (e) { report.issues.push(e instanceof Error ? e.message.slice(0, 300) : "Gameplay observation failed."); }
  }
  return { scope: GAMEPLAY_SCOPE, status: reports.every(r => r.ok) ? "passed" : "failed", scenarios: reports };
}
