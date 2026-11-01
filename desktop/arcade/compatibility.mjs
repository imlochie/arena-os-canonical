/**
 * Admission policy, not a Wine/Proton launch driver. Hardware advertisements and
 * installed commands never establish containment, gameplay, or local ownership.
 */
export function assessCompatibilityHost({
  platform = process.platform,
  arch = process.arch,
  context = "desktop",
  facilities = null,
} = {}) {
  const desktop = context === "desktop";
  const windows = desktop && platform === "win32" && arch === "x64";
  const localLinux = desktop && platform === "linux";
  const scope = desktop ? "Desktop host" : "Remote/assessment host; not the user's laptop";
  const nativeReason = windows
    ? "Use a compatible pinned Windows native release. Wine and Proton are unnecessary. A successful live LPAC probe is still required."
    : !desktop
      ? "This host assessment does not provide a local desktop bridge or permission to execute games."
      : platform === "win32"
        ? `The native supervisor is verified only as a Windows x64 candidate, not ${arch}. Do not install Wine to work around architecture support.`
        : "Arena's current owned native supervisor is Windows LPAC/Job only; there is no registered Linux game supervisor.";
  const wineReasons = platform === "win32"
    ? ["Use the game's compatible Windows native release rather than installing Wine."]
    : [
      ...(!localLinux ? ["A local supported Linux execution service is required; hosted previews are not that service."] : []),
      ...(arch !== "x64" ? [`No verified Wine/game ABI pathway exists for ${arch}.`] : []),
      "No Linux filesystem/network containment and owned Wine process-lifecycle driver is registered.",
      "No immutable Linux Wine distribution/dependency set or per-profile prefix lifecycle is provisioned.",
      "Graphics, input, audio, saves, stop/reopen, prefix repair and runtime rollback have no Wine gameplay evidence.",
    ];
  return {
    scope, platform, architecture: arch,
    facilities,
    nativeWindows: { candidate: windows, reason: nativeReason },
    wine: { available: false, status: "unavailable", reasons: wineReasons },
    proton: { available: false, status: "unavailable", reasons: platform === "win32"
      ? ["Use a compatible Windows native release; Proton is a Linux compatibility tool."]
      : [
        "No verified Proton launch/distribution path is registered.",
        "Valve's documented path uses the Linux Steam client and its runtime/tool context. A separately verified standalone runner is an alternative, not implemented here.",
        "Steam Linux Runtime/pressure-vessel or an equivalent verified runner, matching ABI/drivers, distribution licenses and isolated prefix/process ownership must be assessed together.",
        "Finding a proton script, Steam installation or container command is not execution or containment proof.",
      ] },
    gameplayVerified: false,
  };
}
