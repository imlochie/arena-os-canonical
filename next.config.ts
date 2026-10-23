import type { NextConfig } from "next";
import { ARCADE_HOST_CSP } from "./src/lib/games/sandbox";

// onnxruntime-node MUST stay external: it resolves its native binding
// (bin/napi-v6/<platform>/*.node) relative to its own module directory. If
// Turbopack bundles the JS wrapper into a server chunk (proven: it did, and
// the package never appeared in the traced standalone node_modules), the
// relocated wrapper cannot find the binding and the stem machine dies with
// "onnxruntime-node is not available" in the packaged app. pg gets this
// treatment from Next's default list; onnxruntime-node is not on it.
// @ffprobe-installer/@ffmpeg-installer resolve their platform binary via a
// runtime require + __dirname-relative path. Bundling their index into a
// server chunk breaks that resolution (proven live: dev server reported
// "no installer package" while the same package resolved fine from plain
// node), which silently killed tier-2 binary discovery and with it every
// server-side audio probe in dev/web deployments on machines without
// system ffmpeg. Keeping them external restores the documented order:
// env override → installer package → PATH.
const externalPackages = ["onnxruntime-node", "@ffmpeg-installer/ffmpeg", "@ffprobe-installer/ffprobe"];

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
          "*": [
            "./node_modules/onnxruntime-node/bin/**",
            // ffmpeg/ffprobe installer trees: resolved at runtime from the
            // filesystem (bundler-proof tier in src/lib/waveyard/ffmpeg.ts),
            // so tracing must carry them into the standalone server.
            "./node_modules/@ffmpeg-installer/**",
            "./node_modules/@ffprobe-installer/**",
          ],
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

// srcdoc games cannot navigate even their own frame to another endpoint.
nextConfig.headers = async () => [{
  source: "/arcade",
  headers: [{ key: "Content-Security-Policy", value: ARCADE_HOST_CSP }],
}];

export default nextConfig;
