import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The dev server is reached through a Cloudflare tunnel over HTTPS, so HMR
// must use a secure websocket on port 443 and accept any Host header.
// Do not change the server options: ports and host rules are fixed.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  optimizeDeps: {
    include: [
      "react",
      "react-dom",
      "react-dom/client",
      "lucide-react",
      "sonner",
      "clsx",
      "tailwind-merge",
      "class-variance-authority",
      "radix-ui",
    ],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    host: true,
    port: 5173,
    strictPort: true,
    allowedHosts: true,
    hmr: {
      protocol: "wss",
      clientPort: 443,
    },
    proxy: {
      "/api": "http://localhost:3001",
    },
  },
});
