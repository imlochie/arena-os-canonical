import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Produces .next/standalone: a self-contained server with only the modules
  // actually imported. Required by the Dockerfile and keeps the runtime image
  // from carrying the whole build toolchain.
  output: "standalone",
};

export default nextConfig;
