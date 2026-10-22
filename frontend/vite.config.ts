import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

// In development the API runs on Django (port 8000 unless API_TARGET says
// otherwise). Proxying /api keeps the browser on one origin, so no CORS setup.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "");
  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: {
        "/api": env.API_TARGET || "http://127.0.0.1:8000",
      },
    },
  };
});
