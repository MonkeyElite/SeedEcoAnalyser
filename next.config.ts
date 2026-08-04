import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Vinext packages the production server and its runtime dependencies into
  // dist/standalone. This keeps the final Docker image small and self-contained.
  output: "standalone",
};

export default nextConfig;
