/** @type {import('next').NextConfig} */
const nextConfig = {
  webpack: (config) => {
    // Solana wallet adapter requires these polyfills
    config.resolve.fallback = {
      ...config.resolve.fallback,
      crypto: false,
      stream: false,
      buffer: false,
    };
    return config;
  },
};

module.exports = nextConfig;
