import type { NextConfig } from "next";

// `output: "standalone"` is enabled ONLY for desktop packaging
// (ARENA_DESKTOP_BUILD=1). Web/dev builds stay exactly as before — the frozen
// Waveyard build path is untouched. The desktop build also excludes repo
// trees that file tracing would otherwise copy into the standalone server
// (spec §15: no repo junk in the package).
const nextConfig: NextConfig =
  process.env.ARENA_DESKTOP_BUILD === "1"
    ? {
        output: "standalone",
        outputFileTracingExcludes: {
          "*": [
            "./desktop/**",
            "./docs/**",
            "./scripts/**",
            "./waveyard-worker/**",
            "./src/**/*.{test,tsx}",
            "./docker-compose.yml",
            "./electron-builder.yml",
            "./desktop-migrations/**",
            "./drizzle/**",
            // Build outputs — CRITICAL: when these directories exist under
            // the repo root, Turbopack's output file tracing recursively
            // includes them in the standalone server (proven: any file, any
            // depth). A previous desktop-release/win-unpacked would then be
            // packaged INSIDE the next installer — recursive self-packaging.
            "./desktop-release/**",
            "./desktop-package/**",
          ],
        },
      }
    : {};

export default nextConfig;
