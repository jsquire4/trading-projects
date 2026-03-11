/** @type {import('next').NextConfig} */
const path = require("path");

const nextConfig = {
  transpilePackages: [],
  webpack: (config) => {
    // Solana wallet adapter requires these polyfills
    config.resolve.fallback = {
      ...config.resolve.fallback,
      crypto: false,
      stream: false,
      buffer: false,
    };
    // Allow imports from services/shared/src
    config.resolve.alias = {
      ...config.resolve.alias,
      "@shared": path.resolve(__dirname, "../../services/shared/src"),
    };
    return config;
  },
};

module.exports = nextConfig;
