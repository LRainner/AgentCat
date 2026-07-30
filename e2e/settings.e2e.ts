import { expect, test } from "@playwright/test";

const config = {
  version: 1,
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
    pointerDeadzone: 20,
    clickToWave: true,
    doubleClickToJump: true,
  },
  codex: {
    hooksEnabled: true,
    showLiveStatus: true,
    showTaskSummary: true,
    bubbleScale: 1,
    bubbleOpacity: 1,
  },
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript((mockConfig) => {
    let callbackId = 0;
    const callbacks = new Map<number, (...args: unknown[]) => unknown>();
    const commandLog: string[] = [];
    Object.defineProperty(window, "__TAURI_TEST_COMMANDS__", { value: commandLog });
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      value: {
        transformCallback(callback: (...args: unknown[]) => unknown) {
          callbackId += 1;
          callbacks.set(callbackId, callback);
          return callbackId;
        },
        unregisterCallback(id: number) {
          callbacks.delete(id);
        },
        async invoke(command: string, args: Record<string, unknown> = {}) {
          commandLog.push(command);
          switch (command) {
            case "plugin:app|version": return "1.1.0";
            case "plugin:updater|check": return {
              rid: 1,
              currentVersion: "1.1.0",
              version: "1.2.0",
              date: "2026-07-26T00:00:00Z",
              body: "Test release",
              rawJson: {},
            };
            case "plugin:updater|download": {
              const channel = args.onEvent as { id?: number } | undefined;
              const notify = channel?.id ? callbacks.get(channel.id) : undefined;
              notify?.({ event: "Started", data: { contentLength: 1024 } });
              notify?.({ event: "Progress", data: { chunkLength: 1024 } });
              notify?.({ event: "Finished" });
              return 2;
            }
            case "plugin:updater|install": return null;
            case "plugin:process|restart": return null;
            case "plugin:resources|close": return null;
            case "get_config": return structuredClone(mockConfig);
            case "scan_pets": return { pets: [], diagnostics: [], codexBundles: [] };
            case "hook_status": return {
              path: "C:\\Users\\Tester\\.codex\\config.toml",
              exists: true,
              valid: true,
              installedEvents: 10,
              expectedEvents: 10,
              message: "Hook 已安装",
            };
            case "hook_runtime_status": return {
              receiverRunning: true,
              socketPath: "127.0.0.1:47321",
              verifiedAt: null,
              lastRealEventAt: null,
              lastRealEvent: null,
            };
            case "autostart_status": return false;
            default: return null;
          }
        },
      },
      configurable: true,
    });
  }, config);
});

test("switches between the three settings pages", async ({ page }) => {
  await page.goto("/settings.html");
  await expect(page.locator("#current-version")).toHaveText("v1.1.0");
  await expect(page.locator('[data-settings-panel="general"]')).toBeVisible();

  await page.getByRole("tab", { name: /Codex/ }).click();
  await expect(page).toHaveURL(/#codex$/);
  await expect(page.locator('[data-settings-panel="codex"]')).toBeVisible();
  await expect(page.locator('[data-settings-panel="general"]')).toBeHidden();

  await page.getByRole("tab", { name: /关于/ }).click();
  await expect(page).toHaveURL(/#about$/);
  await expect(page.locator('[data-settings-panel="about"]')).toBeVisible();
  await expect(page.locator("#settings-page-title")).toHaveText("关于");
});

test("shows a persisted update indicator until the about page is viewed", async ({ page }) => {
  await page.goto("/settings.html");
  await page.evaluate(() => {
    localStorage.setItem("agent-cat-update-state", JSON.stringify({
      version: 1,
      checkedAt: Date.now(),
      checkedFromVersion: "1.1.0",
      availableVersion: "1.2.0",
      seenVersion: null,
    }));
  });
  await page.reload();

  await expect(page.locator("#about-update-dot")).toBeVisible();
  await page.getByRole("tab", { name: /关于/ }).click();
  await expect(page.locator("#about-update-dot")).toBeHidden();
  await expect(page.locator("#update-status-title")).toHaveText("发现新版本 v1.2.0");
  await expect(page.getByRole("button", { name: "下载更新" })).toBeVisible();
});

test("keeps the sidebar fixed and renders the app and navigation icons", async ({ page }) => {
  await page.goto("/settings.html#about");
  await expect.poll(() => page.locator(".settings-brand-mark").evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  await expect.poll(() => page.locator(".about-logo").evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  await expect(page.locator('[data-settings-page="general"] [data-icon="settings"] svg')).toBeVisible();
  await expect(page.locator('[data-settings-page="codex"] [data-icon="bot"] svg')).toBeVisible();
  await expect(page.locator('[data-settings-page="about"] [data-icon="info"] svg')).toBeVisible();
  await expect(page.locator(".update-status-icon")).toHaveText("↻");

  const layout = await page.locator(".settings-shell").evaluate((shell) => {
    const sidebar = shell.querySelector<HTMLElement>(".settings-sidebar")!;
    const content = shell.querySelector<HTMLElement>(".settings-content")!;
    return {
      shellWidth: shell.getBoundingClientRect().width,
      shellHeight: shell.getBoundingClientRect().height,
      sidebarWidth: sidebar.getBoundingClientRect().width,
      contentHeight: content.getBoundingClientRect().height,
      contentOverflowY: getComputedStyle(content).overflowY,
      pageScrollWidth: document.documentElement.scrollWidth,
    };
  });

  expect(layout).toEqual({
    shellWidth: 920,
    shellHeight: 720,
    sidebarWidth: 188,
    contentHeight: 720,
    contentOverflowY: "auto",
    pageScrollWidth: 920,
  });
  await page.screenshot({ path: "test-results/settings-about.png", fullPage: true });
});

test("downloads a signed update and offers installation", async ({ page }) => {
  await page.goto("/settings.html#about");
  await page.getByRole("button", { name: "检查更新" }).click();
  await expect(page.locator("#update-status-card")).toHaveAttribute("data-state", "ready");
  await expect(page.locator("#update-status-title")).toHaveText("v1.2.0 已准备好");
  await expect(page.locator("#update-progress-bar")).toHaveAttribute("style", /width: 100%/);
  await expect(page.getByRole("button", { name: "检查更新" })).toBeHidden();
  await page.getByRole("button", { name: "安装并重启" }).click();
  await expect.poll(() => page.evaluate(() => (
    window as unknown as { __TAURI_TEST_COMMANDS__: string[] }
  ).__TAURI_TEST_COMMANDS__)).toContain("plugin:updater|install");
});

test("keeps the update status tile still while the progress ring spins", async ({ page }) => {
  await page.goto("/settings.html#about");
  await page.locator("#update-status-card").evaluate((card) => {
    (card as HTMLElement).dataset.state = "checking";
  });

  const animation = await page.locator("#update-status-card").evaluate((card) => ({
    tile: getComputedStyle(card.querySelector<HTMLElement>(".update-status-icon")!).animationName,
    glyph: getComputedStyle(card.querySelector<HTMLElement>(".update-status-glyph")!).animationName,
  }));

  expect(animation).toEqual({ tile: "none", glyph: "update-spin" });
});

test("hides the empty settings message container", async ({ page }) => {
  await page.goto("/settings.html#about");
  await expect(page.locator("#settings-message")).toBeHidden();
});
