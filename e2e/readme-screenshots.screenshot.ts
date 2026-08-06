import { expect, test } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = path.join(root, "docs", "images");
const packageVersion = (JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { version: string }).version;
const showcaseDirectory = path.join(root, "e2e", "fixtures", "readme-showcase");
const showcaseDocument = readFileSync(path.join(showcaseDirectory, "index.html"), "utf8").replace(
  '<link rel="stylesheet" href="./style.css" />',
  `<style>${readFileSync(path.join(showcaseDirectory, "style.css"), "utf8")}</style>`,
);

const config = {
  version: 1,
  language: "cn",
  pet: null,
  petSources: { scanCodexBuiltin: true, scanCodexCustom: true, extraDirectories: [] },
  window: {
    x: null,
    y: null,
    scale: 1,
    petOpacity: 1,
    alwaysOnTop: true,
    mousePassthrough: false,
    lockPosition: false,
  },
  behavior: {
    followPointer: true,
    pointerRadius: 500,
    pointerDeadzone: 36,
    clickToWave: true,
    doubleClickToJump: true,
  },
  codex: {
    hooksEnabled: true,
    showLiveStatus: true,
    showTaskSummary: true,
    bubbleScale: 1,
    bubbleOpacity: 0.94,
  },
  claudeCode: { hooksEnabled: false, showLiveStatus: true, showTaskSummary: true },
};

const statusEvents = [
  { version: 1, agent: "codex", sessionId: "docs", turnId: "turn-docs", event: "UserPromptSubmit", timestamp: 1000, title: "完善项目文档" },
  { version: 1, agent: "codex", sessionId: "checks", turnId: "turn-checks", event: "PreToolUse", timestamp: 2000, title: "运行发布检查", toolName: "Bash" },
  { version: 1, agent: "codex", sessionId: "review", turnId: "turn-review", event: "PermissionRequest", timestamp: 3000, title: "检查最新改动" },
];

test.beforeAll(() => mkdirSync(outputDirectory, { recursive: true }));

test.beforeEach(async ({ page }) => {
  await page.addInitScript(({ mockConfig, mockEvents, version }) => {
    let callbackId = 0;
    let eventIndex = 0;
    const callbacks = new Map<number, (...args: unknown[]) => unknown>();
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      value: {
        metadata: {
          currentWindow: { label: "main" },
          currentWebview: { label: "main" },
          windows: [{ label: "main" }],
          webviews: [{ label: "main", windowLabel: "main" }],
        },
        transformCallback(callback: (...args: unknown[]) => unknown) {
          callbackId += 1;
          callbacks.set(callbackId, callback);
          return callbackId;
        },
        unregisterCallback(id: number) { callbacks.delete(id); },
        async invoke(command: string) {
          switch (command) {
            case "plugin:app|version": return version;
            case "get_config": return structuredClone(mockConfig);
            case "scan_pets": return { pets: [], diagnostics: [], codexBundles: [] };
            case "get_live_event": return location.pathname.endsWith("/status.html")
              ? structuredClone(mockEvents[eventIndex++] ?? null)
              : null;
            case "hook_status": return {
              path: "~/.codex/hooks.json",
              exists: true,
              valid: true,
              globallyDisabled: false,
              installedEvents: 11,
              expectedEvents: 11,
              message: "Agent Cat Hook 已安装",
            };
            case "hook_runtime_status": return {
              receiverRunning: true,
              socketPath: "agent-cat.sock",
              verifiedAt: Date.now(),
              lastRealEventAt: Date.now(),
              lastRealEvent: "PermissionRequest",
            };
            case "autostart_status": return true;
            case "plugin:event|listen": return 1;
            default: return null;
          }
        },
      },
      configurable: true,
    });
  }, { mockConfig: config, mockEvents: statusEvents, version: packageVersion });
});

test("generates the README product screenshots", async ({ page }) => {
  await page.route("**/__readme-showcase", (route) => route.fulfill({
    body: showcaseDocument,
    contentType: "text/html",
  }));
  await page.goto("/__readme-showcase");
  const status = page.frameLocator('iframe[name="status"]');
  const settings = page.frameLocator('iframe[name="settings"]');
  const pet = page.frameLocator('iframe[name="pet"]');
  await expect(status.locator(".status-card")).toHaveCount(3);
  await expect(status.locator("#status-toggle")).toHaveAttribute("aria-expanded", "false");
  await expect(pet.locator("#fallback-cat")).toBeVisible();
  await expect(settings.locator("#codex-integration")).toHaveAttribute("data-state", "connected");
  await Promise.all([
    status.locator("head").evaluate((head) => {
      const style = document.createElement("style");
      style.textContent = "*,*::before,*::after{animation:none!important}";
      head.append(style);
    }),
    pet.locator("head").evaluate((head) => {
      const style = document.createElement("style");
      style.textContent = "*,*::before,*::after{animation:none!important}";
      head.append(style);
    }),
    settings.locator("head").evaluate((head) => {
      const style = document.createElement("style");
      style.textContent = "*,*::before,*::after{animation:none!important;transition:none!important}";
      head.append(style);
    }),
  ]);

  await status.locator("#status-toggle").click();
  await expect(status.locator("#status-toggle")).toHaveAttribute("aria-expanded", "true");
  await page.locator("#showcase").screenshot({
    path: path.join(outputDirectory, "agent-cat-overview.png"),
    animations: "disabled",
  });
});
