import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
  },
  build: {
    rollupOptions: {
      output: {
        // Split the heavy, rarely-changing vendor libraries into their own
        // chunks so the main app bundle stays under the 500 kB warning and
        // returning users keep these cached across app deploys.
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          // Core React runtime only — keeping react-router et al. in the
          // general vendor bucket avoids a circular chunk reference.
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id))
            return "vendor-react";
          if (id.includes("lightweight-charts")) return "vendor-charts";
          if (id.includes("framer-motion")) return "vendor-motion";
          if (id.includes("@tanstack")) return "vendor-query";
          if (id.includes("lucide-react")) return "vendor-icons";
          return "vendor";
        },
      },
    },
  },
});
