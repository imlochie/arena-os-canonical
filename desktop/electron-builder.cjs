module.exports = {
  appId: "ai.arena.os",
  productName: "ArenaForge",
  directories: { output: "../generated-artifacts/windows", buildResources: "build" },
  files: ["dist/**", "package.json", "!node_modules/**"],
  extraResources: [
    { from: "stage/server", to: "server" },
    { from: "stage/web", to: "web" },
    { from: "stage/chromium", to: "chromium" },
    { from: "stage/embedded-postgres", to: "embedded-postgres" },
    { from: "../lib/arena/desktop-migrations", to: "desktop-migrations", filter: ["*.sql"] },
  ],
  asar: true,
  npmRebuild: false,
  win: { target: [{ target: "nsis", arch: ["x64"] }] },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    deleteAppDataOnUninstall: false,
  },
};
