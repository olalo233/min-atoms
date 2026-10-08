import type { NextConfig } from "next";
import { resolve } from "node:path";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  turbopack: { root: resolve(__dirname, "../..") },
  outputFileTracingRoot: resolve(__dirname, "../.."),
  transpilePackages: ["@min-atoms/db"],
};

export default nextConfig;
