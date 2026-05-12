/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // wagmi / viem 在 ESM-only 包上需要的 polyfill 兼容
  webpack: (config) => {
    config.resolve.fallback = { ...config.resolve.fallback, fs: false, net: false, tls: false };
    config.externals.push("pino-pretty", "lokijs", "encoding");
    return config;
  },
};

module.exports = nextConfig;
