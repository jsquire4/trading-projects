import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        yes: { DEFAULT: "#22c55e", dark: "#16a34a" },
        no: { DEFAULT: "#ef4444", dark: "#dc2626" },
        accent: "#3b82f6",
      },
    },
  },
  plugins: [],
};

export default config;
