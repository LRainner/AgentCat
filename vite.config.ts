import { defineConfig } from "vite";

export default defineConfig({
  root: "src",
  clearScreen: false,
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        pet: "src/index.html",
        status: "src/status.html",
        settings: "src/settings.html",
        debug: "src/pet-debug.html",
      },
    },
  },
  server: {
    strictPort: true,
    port: 1420,
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
});
