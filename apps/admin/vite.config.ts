import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (id.includes("@xterm")) return "vendor-xterm";
          if (id.includes("@xyflow") || id.includes("dagre")) return "vendor-flow";
          if (id.includes("@ant-design/pro-components")) return "vendor-pro";
          if (id.includes("antd") || id.includes("@ant-design/icons")) return "vendor-antd";
          if (id.includes("react-router") || id.includes("react-dom") || id.includes("/react/")) {
            return "vendor-react";
          }
        },
      },
    },
  },
  server: {
    port: 3000,
    // Vite 6+ rejects unknown Host headers (e.g. ngrok tunnels). Leading "." allows subdomains.
    allowedHosts: [
      "localhost",
      ".ngrok-free.dev",
      ".ngrok.io",
      ".ngrok.app",
    ],
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
