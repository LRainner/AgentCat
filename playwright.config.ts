import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  fullyParallel: true,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:1420",
    viewport: { width: 920, height: 720 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "e2e",
      testMatch: "**/*.e2e.ts",
    },
    {
      name: "screenshots",
      testMatch: "**/*.screenshot.ts",
      fullyParallel: false,
      workers: 1,
      use: {
        viewport: { width: 1400, height: 560 },
        reducedMotion: "reduce",
        screenshot: "off",
        trace: "off",
      },
    },
  ],
  webServer: {
    command: "npm run dev -- --host 127.0.0.1",
    url: "http://127.0.0.1:1420/settings.html",
    reuseExistingServer: true,
  },
});
