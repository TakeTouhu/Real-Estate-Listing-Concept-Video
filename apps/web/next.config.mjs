/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Internal workspace packages are consumed as TypeScript source.
  transpilePackages: ["@app/shared", "@app/observability", "@app/video-providers"],
  // Linting is run once at the repo root via the flat ESLint config.
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: false },
};

export default nextConfig;
