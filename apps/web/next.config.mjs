import process from "node:process";
import { fixedHeaderRules } from "./fixed-headers.mjs";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // No `X-Powered-By: Next.js` (ADR-0174 Decision 8).
  poweredByHeader: false,
  // Internal workspace packages are consumed as TypeScript source.
  transpilePackages: [
    "@app/shared",
    "@app/observability",
    "@app/video-providers",
    "@app/domain",
    "@app/database",
    "@app/storage",
    "@app/ai-providers",
  ],
  // Native/binary packages must not be bundled by the server compiler.
  serverExternalPackages: ["@prisma/client", ".prisma/client", "sharp"],
  // Linting is run once at the repo root via the flat ESLint config.
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: false },
  // The fixed security headers and the API policy (ADR-0174 Decisions 8 and 9), frozen at `next build`.
  async headers() {
    return fixedHeaderRules(process.env.NODE_ENV);
  },
};

export default nextConfig;
