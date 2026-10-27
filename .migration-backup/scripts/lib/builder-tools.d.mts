/** Toolchain archives app-builder-lib requests for a Windows NSIS build. */
export declare const KNOWN_TOOLS: Record<
  string,
  { releaseName: string; sha256: string; purpose: string }
>;
/** Browser-download source URLs for the toolchain archives. */
export declare const TOOL_SOURCE_URLS: Record<string, string>;
export declare class ToolSeedError extends Error {
  constructor(message: string);
}
/** Mirrors app-builder-lib's cache-directory resolution. */
export declare function builderCacheRoot(options?: {
  platform?: string;
  env?: Record<string, string | undefined>;
}): string;
export declare function sha256File(file: string): Promise<string>;
/** Verify (sha256) and place one toolchain archive into the archive cache. */
export declare function seedArchive(
  file: string,
  options?: {
    cacheRoot?: string;
    table?: Record<string, { releaseName: string; sha256: string; purpose: string }>;
  },
): Promise<{ name: string; releaseName: string; archiveCachePath: string }>;
/** Which expected tools are seeded/extracted/missing. */
export declare function toolStatus(
  cacheRoot?: string,
  table?: Record<string, { releaseName: string; sha256: string; purpose: string }>,
): Array<{ name: string; releaseName: string; purpose: string; archiveSeeded: boolean; extracted: boolean }>;
/** Fail when our checksum table drifts from the installed app-builder-lib. */
export declare function assertTableMatchesInstalledLib(
  root: string,
  table?: Record<string, { releaseName: string; sha256: string; purpose: string }>,
): Promise<void>;
