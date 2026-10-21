import test from "node:test";
import assert from "node:assert/strict";
import { parseGameplayContract } from "./gameplay-contract";
const document = (value: unknown) => `<script id="arena-gameplay" type="application/json">${JSON.stringify(value)}</script>`;
function example() {
  return { version: 1, scenarios: [
    { kind: "controls", name: "Move", steps: [{ press: "ArrowRight" }], checks: [{ selector: "#x", mode: "change" }] },
    { kind: "progress", name: "Score", steps: [{ press: "Space" }], checks: [{ selector: "#score", mode: "increase" }] },
    { kind: "terminal", name: "Win", steps: [{ press: "Space" }], checks: [{ selector: "#state", mode: "equals", value: "won" }] },
    { kind: "restart", name: "Reset", steps: [{ press: "Space" }, { press: "r" }], checks: [{ selector: "#score", mode: "equals", value: "0" }] },
  ] };
}
test("legacy smoke is distinct from required gameplay verification", () => {
  assert.equal(parseGameplayContract("<html>legacy</html>"), undefined);
  assert.throws(() => parseGameplayContract("<html>legacy</html>", true), /exactly one/);
  assert.equal(parseGameplayContract(document(example()), true)?.scenarios.length, 4);
});
test("no duplicate scenarios or executable test programs", () => {
  const value = example(); value.scenarios[1].kind = "controls";
  assert.throws(() => parseGameplayContract(document(value)), /distinct/);
  assert.throws(() => parseGameplayContract(document(example()) + document(example())), /exactly one/);
  assert.throws(() => parseGameplayContract('<script id="arena-gameplay" type="application/json">eval("1")</script>'), /valid JSON/);
});
test("arbitrary selectors, excessive waits and navigation actions are rejected", () => {
  const selector = example(); selector.scenarios[0].checks[0].selector = "iframe > body";
  assert.throws(() => parseGameplayContract(document(selector)), /visible #id/);
  const wait = example(); wait.scenarios[0].steps = Array.from({ length: 5 }, () => ({ waitMs: 500 })) as never;
  assert.throws(() => parseGameplayContract(document(wait)), /2000ms/);
  const nav = example(); nav.scenarios[0].steps = [{ navigate: "external" }] as never;
  assert.throws(() => parseGameplayContract(document(nav)), /Unsupported/);
});
test("vacuous controls and progress checks cannot claim mechanic coverage", () => {
  const value = example(); Object.assign(value.scenarios[0].checks[0], { mode: "equals", value: "0" });
  assert.throws(() => parseGameplayContract(document(value)), /Controls/);
  const progress = example(); progress.scenarios[1].checks[0].mode = "change";
  assert.throws(() => parseGameplayContract(document(progress)), /numeric/);
});
