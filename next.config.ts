import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const nextConfig: NextConfig = {
  // PGlite charge des fichiers WebAssembly : il ne doit pas être empaqueté.
  serverExternalPackages: ["@electric-sql/pglite", "pg"],
  poweredByHeader: false,
  output: "standalone",
  experimental: {
    // Imports CSV (2 Mo) et pièces jointes (10 Mo), contrôlés aussi côté serveur, transmis par Server Action.
    serverActions: { bodySizeLimit: "11mb" },
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
