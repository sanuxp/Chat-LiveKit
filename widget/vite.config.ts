import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Library build -> dist/widget.js (single IIFE bundle). `public/index.html` (demo host page) is copied to dist/.
export default defineConfig({
  plugins: [react()],
  define: { "process.env.NODE_ENV": JSON.stringify("production"), global: "globalThis" },
  build: {
    lib: { entry: "src/embed.ts", name: "SupportChatBundle", formats: ["iife"], fileName: () => "widget.js" },
    chunkSizeWarningLimit: 4000,
  },
  server: { port: 5173 },
});
