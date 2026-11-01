// Run ONLY in the disposable, systemd-delegated CI service. The cgroup is
// derived from this process, never guessed from another process/user's path.
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { probeLinuxAdmission } from "./arcade/linux-admission.mjs";

const output = path.resolve("generated-artifacts/arcade-linux-admission");
await mkdir(output, { recursive: true });
let report = {
  scope: "ci-admission-only", gameplayVerified: false,
  sourceRevision: process.env.ARENA_SOURCE_REVISION ?? "unknown",
  status: "blocked",
};
try {
  if (process.platform !== "linux" || process.arch !== "x64")
    throw new Error("Linux x64 is required.");
  const entries = (await readFile("/proc/self/cgroup", "utf8")).trim().split("\n");
  const entry = entries.find(line => line.startsWith("0::/"));
  if (!entry) throw new Error("Unified cgroup-v2 membership is required.");
  const member = entry.slice(3);
  // Refuse invocation from the host/root/ordinary runner cgroup. The workflow
  // owns this short-lived service and systemd removes it after termination.
  if (!/^\/system\.slice\/arena-admission-[a-zA-Z0-9-]+\.service$/.test(member))
    throw new Error("Run inside the dedicated arena-admission CI service.");
  const cgroupRoot = path.join("/sys/fs/cgroup", member);
  // cgroup v2 forbids enabling domain controllers while this service's own
  // processes occupy its root. Move the trusted owner into a child first.
  // systemd owns/removes this service and that child after this process exits.
  const ownerGroup = path.join(cgroupRoot, "supervisor");
  await mkdir(ownerGroup);
  await writeFile(path.join(ownerGroup, "cgroup.procs"), String(process.pid));
  await writeFile(path.join(cgroupRoot, "cgroup.subtree_control"), "+cpu +memory +pids");
  report = { ...report, ...await probeLinuxAdmission({ cgroupRoot }) };
  if (!report.probeGroupCleaned) report.status = "blocked";
} catch (error) {
  report.diagnostic = String(error.message).slice(0, 4096);
}
await writeFile(path.join(output, "admission.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
if (report.status !== "primitives-only") process.exitCode = 2;
