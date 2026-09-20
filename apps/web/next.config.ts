import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@waveyard/audio", "@waveyard/auth", "@waveyard/database", "@waveyard/queue", "@waveyard/storage", "@waveyard/types"],
};
export default nextConfig;
