import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        terminal: {
          bg: "#000000",
          dim: "#003311",
          mid: "#006633",
          fg: "#00FF66",
          bright: "#80FFB3",
          amber: "#FFB000",
          red: "#FF3366",
        },
      },
      fontFamily: {
        mono: [
          "JetBrains Mono",
          "Menlo",
          "Monaco",
          "Consolas",
          '"Courier New"',
          "monospace",
        ],
      },
    },
  },
  plugins: [],
};

export default config;
