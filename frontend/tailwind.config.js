/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: {
          DEFAULT: "#05070f",
          panel: "rgba(10, 15, 30, 0.55)",
          "panel-solid": "#0a0e1a",
          elevated: "rgba(22, 30, 52, 0.6)",
          border: "rgba(255, 255, 255, 0.06)",
          "border-glowing": "rgba(99, 102, 241, 0.25)",
        },
        accent: {
          buy: "#10b981", // vibrant emerald
          sell: "#f43f5e", // electric rose
          hold: "#fbbf24", // warm amber
          info: "#6366f1", // premium indigo
          "buy-glow": "rgba(16, 185, 129, 0.15)",
          "sell-glow": "rgba(244, 63, 94, 0.15)",
          "info-glow": "rgba(99, 102, 241, 0.15)",
        },
      },
      backgroundImage: {
        "panel-glow": "radial-gradient(at top left, rgba(99,102,241,0.08), transparent 50%), radial-gradient(at bottom right, rgba(16,185,129,0.06), transparent 50%)",
        "app-radial":
          "radial-gradient(1200px 900px at 0% 0%, rgba(99, 102, 241, 0.12), transparent 55%), radial-gradient(1000px 800px at 100% 100%, rgba(16, 185, 129, 0.08), transparent 60%), #05070f",
        "glow-card": "linear-gradient(135deg, rgba(255,255,255,0.05), rgba(255,255,255,0.01))",
        "active-gradient": "linear-gradient(90deg, rgba(99,102,241,0.15) 0%, rgba(99,102,241,0.02) 100%)",
        "buy-gradient": "linear-gradient(135deg, rgba(16,185,129,0.1) 0%, rgba(16,185,129,0) 100%)",
        "sell-gradient": "linear-gradient(135deg, rgba(244,63,94,0.1) 0%, rgba(244,63,94,0) 100%)",
      },
      boxShadow: {
        glass: "0 1px 0 rgba(255,255,255,0.05) inset, 0 16px 36px -12px rgba(0,0,0,0.8)",
        "glow-buy": "0 0 16px rgba(16, 185, 129, 0.25)",
        "glow-sell": "0 0 16px rgba(244, 63, 94, 0.25)",
        "glow-indigo": "0 0 20px rgba(99, 102, 241, 0.2)",
      },
      backdropBlur: {
        glass: "16px",
      },
      fontFamily: {
        sans: ["Inter", "Plus Jakarta Sans", "system-ui", "-apple-system", "sans-serif"],
        display: ["Plus Jakarta Sans", "Inter", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "monospace"],
      },
      animation: {
        "pulse-slow": "pulse 4s cubic-bezier(0.4, 0, 0.6, 1) infinite",
        "float-slow": "float 8s ease-in-out infinite",
      },
      keyframes: {
        float: {
          "0%, 100%": { transform: "translateY(0px) scale(1)" },
          "50%": { transform: "translateY(-10px) scale(1.05)" },
        },
      },
    },
  },
  plugins: [],
};
