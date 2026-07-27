/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Internal workspace packages are consumed as TypeScript source.
  transpilePackages: [
    "@app/shared",
    "@app/observability",
    "@app/video-providers",
    "@app/domain",
    "@app/database",
    "@app/storage",
  ],
  // Native/binary packages must not be bundled by the server compiler.
  serverExternalPackages: ["@prisma/client", ".prisma/client", "sharp"],
  // Linting is run once at the repo root via the flat ESLint config.
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: false },
};

export default nextConfig;
