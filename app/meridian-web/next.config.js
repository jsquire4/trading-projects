/** @type {import('next').NextConfig} */
const path = require("path");

const nextConfig = {
  transpilePackages: [],
  webpack: (config) => {
    // Solana wallet adapter requires these polyfills
    // NOTE: buffer: false can break Solana transaction serialization in the browser.
    // If buffer-related errors occur, run `yarn add buffer` and change to:
    //   buffer: require.resolve("buffer/")
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
