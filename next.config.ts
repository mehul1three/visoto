import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The parent directory has its own lockfile, so Next infers the workspace
  // root one level too high and warns on every start. This pins it here.
  turbopack: { root: __dirname },
  /* config options here */
};

export default nextConfig;
