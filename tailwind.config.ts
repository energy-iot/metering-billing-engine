// tailwind.config.ts — Drop into project root.
//
// Tailwind v4 uses CSS-first config via @theme inline in globals.css.
// This file declares content globs and JS-only extensions: spacing
// scale, named radii, motion, and elevation tokens. Components must
// consume named values (`p-3`, `rounded-md`, `shadow-elev-2`,
// `duration-base`) — never inline px / boxShadow strings.
import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/app/**/*.{ts,tsx}",
    "./src/components/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      // Spacing scale from MBE design tokens.
      spacing: {
        "0": "0",
        "0.5": "2px",
        "1": "4px",
        "1.5": "6px",
        "2": "8px",
        "3": "12px",
        "4": "16px",
        "5": "20px",
        "6": "24px",
        "8": "32px",
        "10": "40px",
        "12": "48px",
        "16": "64px",
        "20": "80px",
        "24": "96px",
      },
      borderRadius: {
        sm: "4px",
        md: "6px",
        lg: "8px",
        xl: "12px",
        pill: "9999px",
      },
      transitionTimingFunction: {
        snap: "cubic-bezier(.2,.7,.3,1)",
      },
      transitionDuration: {
        fast: "120ms",
        base: "180ms",
        slow: "260ms",
      },
      boxShadow: {
        "elev-1": "0 1px 2px rgba(24,24,27,0.04), 0 1px 1px rgba(24,24,27,0.03)",
        "elev-2": "0 2px 4px rgba(24,24,27,0.05), 0 4px 10px rgba(24,24,27,0.04)",
        "elev-3": "0 6px 14px rgba(24,24,27,0.08), 0 14px 32px rgba(24,24,27,0.06)",
      },
    },
  },
  plugins: [],
};
export default config;
