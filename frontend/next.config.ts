import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Both are native or WASM binaries that the bundler must not try to trace
  // and rewrite: sharp is a platform-specific .node, and heic-decode reaches
  // libheif through a WASM bundle that only resolves when it is required at
  // runtime from node_modules. See lib/images.ts for what they are for.
  serverExternalPackages: ["sharp", "heic-decode", "libheif-js"],
};

export default nextConfig;
