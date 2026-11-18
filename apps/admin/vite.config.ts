import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "/admin/",
  plugins: [react()],
  server: { proxy: { "/api": "http://localhost:8080", "/admin/config.json": "http://localhost:8080" } },
});
