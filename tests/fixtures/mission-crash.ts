// Controlled model protocol; tools, PostgreSQL and process termination are real.
import { runMission, MissionBusyError } from "../../src/lib/spaces/mission";
const id = process.env.RECOVERY_SPACE_ID!;
const boundary = process.env.RECOVERY_BOUNDARY;
let seen = 0;
try {
  await runMission(id, { goal: "Durable increment and inspection", isolation: "host", agentPlan: boundary ? [
    { name: "Writer", role: "worker", modelId: "controlled" },
  ] : [
    { name: "Writer", role: "worker", modelId: "controlled" }, { name: "Inspector", role: "reviewer", modelId: "controlled" },
  ] }, { leaseMs: Number(process.env.RECOVERY_LEASE_MS ?? 200),
    onCheckpoint: async (point) => { if (point === boundary && ++seen === Number(process.env.RECOVERY_BOUNDARY_N ?? 1)) process.kill(process.pid, "SIGKILL"); },
    generate: async (input) => {
      if (!boundary && input.messages[0].content.includes("agent 2/2")) process.exit(73);
      return { text: JSON.stringify({ actions: JSON.parse(process.env.RECOVERY_ACTIONS ?? '[{"tool":"run_command","args":{"command":"node increment.cjs"}}]'), done: true }), backend: "groq", runtimeLevel: "remote", modelId: "controlled", fallback: false, via: "controlled-test", ms: 0 };
    },
  });
} catch (error) {
  if (error instanceof MissionBusyError) { console.error(error.message); process.exit(74); }
  throw error;
}
