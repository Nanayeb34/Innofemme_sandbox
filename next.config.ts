import type { NextConfig } from "next";

// Every page reads per-team state and cookies, so Cache Components prerendering is off.
const nextConfig: NextConfig = {
  // The MTN MoMo API uses trailing slashes (e.g. /collection/token/); keep them working.
  skipTrailingSlashRedirect: true,
  output: "standalone",
  // Logos are small PNGs; serve them as-is rather than through the image optimiser.
  images: { unoptimized: true },
  // A team's own web page, served from anywhere, may call their world's API straight from the browser.
  // Any site may ask, but only with a key in a header: with "*" a browser never sends this site's cookies along,
  // so a page elsewhere cannot act as someone who is merely signed in to the consoles.
  async headers() {
    return [
      {
        source: "/api/w/:path*",
        headers: [
          { key: "Access-Control-Allow-Origin", value: "*" },
          { key: "Access-Control-Allow-Methods", value: "GET, POST, PUT, PATCH, DELETE, OPTIONS" },
          // "*" does not cover Authorization, which has to be named.
          { key: "Access-Control-Allow-Headers", value: "*, Authorization, Content-Type, X-Team-Key, Ocp-Apim-Subscription-Key, X-Reference-Id, X-Target-Environment, X-Callback-Url, X-Merchant-Id" },
          { key: "Access-Control-Expose-Headers", value: "*" },
          { key: "Access-Control-Max-Age", value: "86400" },
        ],
      },
    ];
  },
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
