import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  worker: {
    format: "es",
  },
  optimizeDeps: {
    // The wasm glue is already plain ESM; leave it (and its .wasm) alone.
    exclude: ["@sda/core"],
  },
  server: {
    port: 5173,
  },
});
