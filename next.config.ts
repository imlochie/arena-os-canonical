import type { NextConfig } from "next";

// onnxruntime-node MUST stay external: it resolves its native binding
// (bin/napi-v6/<platform>/*.node) relative to its own module directory. If
// Turbopack bundles the JS wrapper into a server chunk (proven: it did, and
// the package never appeared in the traced standalone node_modules), the
// relocated wrapper cannot find the binding and the stem machine dies with
// "onnxruntime-node is not available" in the packaged app. pg gets this
// treatment from Next's default list; onnxruntime-node is not on it.
const externalPackages = ["onnxruntime-node"];

// `output: "standalone"` is enabled ONLY for desktop packaging
// (ARENA_DESKTOP_BUILD=1). Web/dev builds stay as before apart from the
// external-packages list, which applies everywhere for the same reason.
// The desktop build also excludes repo trees that file tracing would
// otherwise copy into the standalone server (spec §15: no repo junk in the
// package).
const nextConfig: NextConfig =
  process.env.ARENA_DESKTOP_BUILD === "1"
    ? {
        output: "standalone",
        serverExternalPackages: externalPackages,
        // The native binding is located at RUNTIME via a computed path
        // (bin/napi-v6/<platform>), which file tracing cannot follow — the
        // JS wrapper alone (408K) is useless. Force the binaries into the
        // traced tree; desktop-prepare-server.mjs then prunes to the target
        // platform so the installer ships one platform's ~70-134 MB, not
        // all three (288 MB).
        outputFileTracingIncludes: {
          "*": ["./node_modules/onnxruntime-node/bin/**"],
        },
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
    : { serverExternalPackages: externalPackages };

export default nextConfig;
