import { defineConfig } from "vitest/config";

// Separate from vite.config.ts (whose `root` is `src`) so plugin tests under
// `plugins/` are collected too. `vite build` still uses vite.config.ts.
export default defineConfig({
  root: ".",
  test: {
    include: ["src/**/*.test.ts", "plugins/**/*.test.js"],
  },
});
