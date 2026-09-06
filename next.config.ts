import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // node:sqlite is a Node built-in; keep it out of the bundler.
  serverExternalPackages: [],
};

export default nextConfig;
