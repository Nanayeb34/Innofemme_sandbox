import type { NextConfig } from "next";

// Every page reads per-team state and cookies, so Cache Components prerendering is off.
const nextConfig: NextConfig = {
  // The MTN MoMo API uses trailing slashes (e.g. /collection/token/); keep them working.
  skipTrailingSlashRedirect: true,
  output: "standalone",
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
