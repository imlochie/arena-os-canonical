const fs = require("node:fs");

module.exports = {
  appId: "ai.arena.os",
  productName: "ArenaForge",
  directories: { output: "../generated-artifacts/windows", buildResources: "build" },
  files: ["dist/**", "package.json", "!node_modules/**"],
  extraResources: [
    // An explicit filter keeps the bundled server's node_modules (playwright-core, onnxruntime-node).
    { from: "stage/server", to: "server", filter: ["**/*"] },
    { from: "stage/web", to: "web" },
    { from: "stage/native", to: "native" },
    { from: "stage/chromium", to: "chromium" },
    { from: "stage/embedded-postgres", to: "embedded-postgres" },
    { from: "stage/bin", to: "bin" },
    { from: "stage/arcade-catalog.json", to: "arcade-catalog.json" },
    { from: "THIRD-PARTY-NOTICES.md", to: "THIRD-PARTY-NOTICES.md" },
    { from: "../lib/arena/desktop-migrations", to: "desktop-migrations", filter: ["*.sql"] },
  ],
  asar: true,
  npmRebuild: false,
  win: { target: [{ target: "nsis", arch: ["x64"] }] },
  afterPack: async () => {
    const phaseLog = process.env.ARENA_BUILD_SPACE_PHASE_LOG;
    if (phaseLog) {
      fs.appendFileSync(phaseLog, `${JSON.stringify({
        phase: "unpacked-output-ready",
        atUtc: new Date().toISOString(),
      })}\n`);
    }
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    deleteAppDataOnUninstall: false,
  },
};
