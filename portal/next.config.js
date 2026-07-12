/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  experimental: { typedRoutes: false },
  poweredByHeader: false,
  reactStrictMode: true,
};
module.exports = nextConfig;
