import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In development the API runs on Django (port 8000). Proxying /api keeps the
// browser on one origin, so no CORS setup is needed.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8000",
    },
  },
});
