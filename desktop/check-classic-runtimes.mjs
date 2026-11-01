// Final-pass OWNER-INTERACTIVE acceptance. Never converts fixture/unit simulations
// into Windows or automatic gameplay proof. No input injection or synthetic audio.
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { ArcadePackages, packageKey } from "./arcade/packages.mjs";
import { NativeArcadeHost } from "./arcade/host.mjs";
import { assertClassicProfile } from "./arcade/classic.mjs";

if (process.platform !== "win32" || process.arch !== "x64" || !process.stdin.isTTY)
  throw new Error("Deferred final-pass check requires an interactive Windows x64 desktop with a real audio output. No simulated pass is available.");
const directory = path.resolve(process.argv[2] ?? "generated-artifacts/arcade-native-packages");
const helper = path.resolve(process.argv[3] ?? "desktop/stage/native/arena-native-host.exe");
const output = path.resolve("generated-artifacts/classic-acceptance", `${Date.now()}`);
await mkdir(output, { recursive: true });
const bytes = await readFile(path.join(directory, "arcade-catalog.json")), catalog = JSON.parse(bytes).packages;
const packages = new ArcadePackages({ root: path.join(output, "managed"), catalog }); await packages.initialize();
const host = new NativeArcadeHost({ packages, helper }), io = createInterface({ input: process.stdin, output: process.stdout });
const report = { schemaVersion: 1, platform: process.platform, arch: process.arch, os: os.release(),
  catalogSha256: createHash("sha256").update(bytes).digest("hex"), helperSha256: createHash("sha256").update(await readFile(helper)).digest("hex"),
  observationMethod: "Owner-interactive controls/audio/restored-scene observations plus real native isolation and saved-file evidence. Not automated gameplay verification.",
  adapters: [], failure: null };
const yes = async text => (await io.question(`${text} Type yes only if observed: `)).trim().toLowerCase() === "yes";
const saveFiles = async profile => {
  await assertClassicProfile(profile, packages.root);
  const found = [];
  const walk = async dir => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (/\.sav$|\.srm$|^sky\.\d{3}$/i.test(entry.name)) {
        if ((await lstat(file)).size > 16 * 1024 * 1024) throw new Error("Acceptance save exceeds its bounded read.");
        const b = await readFile(file);
        if (b.length > 16 * 1024 * 1024) throw new Error("Acceptance save exceeds its bounded read.");
        found.push({ file: path.relative(profile, file), bytes: b.length, prefix: [...b.subarray(0, 2)], sha256: createHash("sha256").update(b).digest("hex") });
      }
    }
  };
  await walk(profile); return found;
};
const stop = async run => { if (host.runningKeys().includes(run.key)) await host.stop(run.id); };
try {
  await host.probe();
  report.requirements = host.requirements();
  if (!report.requirements.verified) throw new Error(report.requirements.message);
  for (const id of ["arena-dos-coin", "revolution-bass-freeware", "arena-libretro-coin", "arena-sameboy-coin"]) {
    const game = catalog.find(d => d.id === id);
    if (!game?.classic) throw new Error(`Matching independently built fixture is missing: ${id}`);
    for (const key of [...game.runtimes, packageKey(game)]) {
      const d = packages.catalog.get(key);
      await packages.install(key, path.join(directory, `${d.id}-${d.version}.tar`));
    }
    const result = { game: packageKey(game), pins: game.classic, status: "not-observed" };
    report.adapters.push(result);
    console.log(`\n${id}: ${game.classic.adapter}. Use the actual game window.`);
    console.log(id.includes("dos") ? "A/D moves; Space collects. Reach a nonzero score; hear the beep. Q saves and quits."
      : id.includes("bass") ? "Advance the real character/scene, hear game audio, and save a named slot in ScummVM's menu, then quit."
        : "Move @ to o with mapped arrows; press the mapped Game Boy A button to collect. Hear the tone; retain a nonzero score. Exit the emulator normally.");
    let run = await host.launch(packageKey(game));
    result.controls = await yes("Did the real game visibly respond to controls?");
    result.audio = await yes("Did you hear actual game audio from the intended output?");
    await io.question("After saving progress and quitting the engine normally, press Enter.");
    await stop(run); result.firstExit = host.runs.get(run.id).phase;
    result.savedFiles = await saveFiles(run.profile);
    const gb = game.classic.adapter === "libretro" || game.classic.adapter === "sameboy";
    result.nonzeroFixtureSave = result.savedFiles.some(s => s.prefix[0] >= 1 && s.prefix[0] <= 9 && (!gb || s.prefix[1] === 0x42));
    if (game.classic.adapter === "scummvm") result.nonzeroFixtureSave = result.savedFiles.some(s => /^saves[/\\]sky\.\d{3}$/i.test(s.file) && s.bytes > 0);
    run = await host.launch(packageKey(game));
    result.restored = await yes("After reopening/loading that slot, was the same score or scene visibly restored?");
    await stop(run); result.finalExit = host.runs.get(run.id).phase;
    result.status = result.controls && result.audio && result.restored && result.nonzeroFixtureSave &&
      ["exited", "stopped"].includes(result.firstExit) && ["exited", "stopped"].includes(result.finalExit)
      ? "owner-observed-with-save-file-evidence" : "blocked-or-not-demonstrated";
  }
} catch (error) { report.failure = error.message; process.exitCode = 1; }
finally {
  for (const run of host.runs.values()) if (host.runningKeys().includes(run.key)) await host.stop(run.id).catch(() => {});
  io.close(); await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(`Evidence retained at ${path.join(output, "report.json")}. This does not upgrade Arena's gameplayVerified flag.`);
}
if (report.adapters.some(r => r.status !== "owner-observed-with-save-file-evidence")) process.exitCode = 1;
