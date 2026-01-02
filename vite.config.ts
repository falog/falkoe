import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// NOTE: `localhost` may not be accepted in some embedded contexts.
// We intentionally bind to 127.0.0.1 so the dev URL is stable.
const host = "127.0.0.1";

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],
  base: "./",
  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host,
    hmr: {
      protocol: "ws",
      host,
    },
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
