import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Served by Caddy under /agent/ ; `vite dev` also uses that base (http://localhost:5174/agent/).
export default defineConfig({
  base: "/agent/",
  plugins: [react()],
  build: { chunkSizeWarningLimit: 4000 },
  server: { port: 5174 },
});
