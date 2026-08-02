/** @type {import('next').NextConfig} */
const nextConfig = {
  typedRoutes: true,
  eslint: {
    // The root `pnpm check` runs ESLint before this build. Avoid Next 15's duplicate
    // legacy lint integration, which does not reliably detect a root flat config.
    ignoreDuringBuilds: true,
  },
  transpilePackages: ["@soundhub/types"],
  async rewrites() {
    const apiUrl = process.env.API_URL ?? "http://localhost:4000";

    return [
      {
        source: "/api/:path*",
        destination: `${apiUrl}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
