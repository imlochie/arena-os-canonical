/** Targeted causal proof for the two supported source rules, not general game
 * intelligence. Same opaque iframe/CSP/no-network policy as Arcade validation.
 * Controlled RNG belongs to the verifier, never to the saved game source. */
import { createHash } from "node:crypto";
import type { Browser } from "playwright-core";
import { preview2048Mod, validate2048Bundle } from "./source-2048";
import { ARCADE_HOST_CSP, sandboxGameDocument } from "./sandbox";

let active = 0;
export async function verify2048Rule(input: unknown) {
  const bundle = validate2048Bundle(input);
  const report = { policyVersion: 1, checkedAt: new Date().toISOString(), status: "failed" as "passed" | "failed" | "unavailable", scope: "Pinned 2048 adapter: real keyboard move, board sum delta (merges conserve sum), restart. Controlled random draws .01/.95; no in-progress board persistence or human review.", sourceSha256: bundle.modification.modifiedSha256, patchSha256: createHash("sha256").update(bundle.modification.patch).digest("hex"), previewSha256: createHash("sha256").update(preview2048Mod(bundle)).digest("hex"), browser: "", observations: [] as { baseline: boolean; random: number; before: number; after: number; spawnedValue: number; initialValues: number[]; restartValues: number[] }[], issues: [] as string[] };
  if (active >= 2) return { ...report, status: "unavailable" as const, issues: ["Browser verification busy; no save acknowledged."] };
  active++;
  let browser: Browser | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  try {
    const work = async () => {
      const { chromium } = await import("playwright-core");
      browser = await chromium.launch({
        executablePath: process.env.ARENA_ARCADE_CHROMIUM_PATH || undefined, headless: true, timeout: 5000,
        chromiumSandbox: !(process.env.CI === "true" && process.env.ARENA_ARCADE_CI_NO_SANDBOX === "1"),
        env: Object.fromEntries(["PATH", "HOME", "TMPDIR", "LD_LIBRARY_PATH", "SystemRoot"].flatMap(k => process.env[k] ? [[k, process.env[k]!]] : [])),
        args: ["--disable-dev-shm-usage", "--js-flags=--max-old-space-size=96"],
      });
      if (expired) { await browser.close(); throw new Error("Verification deadline exceeded."); }
      report.browser = browser.version();
      for (const baseline of [true, false]) for (const random of [.01, .95]) {
        const context = await browser.newContext({ serviceWorkers: "block", acceptDownloads: false });
        try {
          await context.addInitScript(value => { Math.random = () => value; }, random);
          const page = await context.newPage(); page.setDefaultTimeout(1200);
          page.on("pageerror", e => report.issues.push(e.message.slice(0, 200)));
          await context.route("**/*", route => route.request().url() === "http://arena-source.invalid/" && route.request().frame() === page.mainFrame()
            ? route.fulfill({ contentType: "text/html", headers: { "Content-Security-Policy": ARCADE_HOST_CSP }, body: "<!doctype html><body>Source rule verification</body>" })
            : (report.issues.push("Sandbox attempted network/navigation."), route.abort()));
          await page.goto("http://arena-source.invalid/");
          await page.evaluate(html => { const f = document.createElement("iframe"); f.setAttribute("sandbox", "allow-scripts"); f.style.cssText = "width:800px;height:650px"; f.srcdoc = html; document.body.append(f); }, sandboxGameDocument(preview2048Mod(bundle, baseline)));
          const frame = page.frameLocator("iframe"), count = frame.locator("#tile-count");
          await count.waitFor({ state: "visible" });
          const values = async () => JSON.parse((await frame.locator("#board-values").textContent())!) as { value: number }[];
          const initial = await values(), before = initial.reduce((s, t) => s + t.value, 0);
          const expected = baseline || bundle.modification.spawnRule === "original" ? random < .9 ? 2 : 4 : 4;
          if (initial.length !== (baseline ? 2 : bundle.modification.initialTiles) || initial.some(t => t.value !== expected)) throw new Error("Initial source spawning/count differs from selected rule.");
          await frame.locator("canvas").click();
          // Opposite the occupied edge under the deterministic empty-cell draw.
          await page.keyboard.press(random < .9 ? "ArrowDown" : "ArrowUp");
          const after = (await values()).reduce((s, t) => s + t.value, 0);
          if (after - before !== expected) throw new Error(`Actual move spawned ${after - before}, expected ${expected}.`);
          await frame.getByRole("button", { name: "Restart", exact: true }).click();
          const restarted = await values();
          if (restarted.length !== initial.length || restarted.some(t => t.value !== expected)) throw new Error("Restart lost the selected spawning rule.");
          report.observations.push({ baseline, random, before, after, spawnedValue: after - before, initialValues: initial.map(t => t.value), restartValues: restarted.map(t => t.value) });
        } finally { await context.close(); }
      }
      if (report.issues.length) throw new Error("Runtime/sandbox error.");
      report.status = "passed";
    };
    await Promise.race([work(), new Promise<never>((_, reject) => { timer = setTimeout(() => { expired = true; reject(new Error("Source rule browser deadline exceeded.")); }, 10000); })]);
  } catch (error) {
    report.status = report.browser ? "failed" : "unavailable";
    report.issues.push(error instanceof Error ? error.message : "Browser verification failed.");
  } finally { if (timer) clearTimeout(timer); await browser?.close().catch(() => {}); active--; }
  return report;
}
