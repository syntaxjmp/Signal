/** @type {import('next').NextConfig} */
const apiUpstream = process.env.API_UPSTREAM_URL || "http://127.0.0.1:4000";

const nextConfig = {
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${apiUpstream}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
