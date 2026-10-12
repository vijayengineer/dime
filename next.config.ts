import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // STATIC_EXPORT=1 produces ./out for nginx (no Node process needed to serve the UI).
  ...(process.env.STATIC_EXPORT === "1" ? { output: "export" as const, images: { unoptimized: true } } : {}),
};

export default nextConfig;
