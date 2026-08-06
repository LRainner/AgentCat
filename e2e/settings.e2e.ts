import { expect, test } from "@playwright/test";

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
  claudeCode: { hooksEnabled: false, showLiveStatus: true, showTaskSummary: true },
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript((mockConfig) => {
    let callbackId = 0;
    const callbacks = new Map<number, (...args: unknown[]) => unknown>();
    const commandLog: string[] = [];
    const failedCommands = new Set<string>();
    const hookStatusOverrides: Record<string, Record<string, unknown>> = {};
    const hookStatus = (agent: string) => ({
      path: agent === "claude-code"
        ? "C:\\Users\\Tester\\.claude\\settings.json"
        : "C:\\Users\\Tester\\.codex\\hooks.json",
      exists: true,
      valid: true,
      globallyDisabled: false,
      installedEvents: agent === "claude-code" ? 0 : 11,
      expectedEvents: agent === "claude-code" ? 13 : 11,
      message: "Hook 已安装",
      ...hookStatusOverrides[agent],
    });
    Object.defineProperty(window, "__TAURI_TEST_COMMANDS__", { value: commandLog });
    Object.defineProperty(window, "__TAURI_TEST_FAILED_COMMANDS__", { value: failedCommands });
    Object.defineProperty(window, "__TAURI_TEST_HOOK_STATUS_OVERRIDES__", { value: hookStatusOverrides });
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
          if (failedCommands.has(command)) throw new Error(`${command} failed`);
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
            case "pet_directory_info": return {
              defaultPath: "C:\\Users\\Tester\\.codex\\pets",
              examplePath: "C:\\Users\\Tester\\Downloads\\codex-pets",
            };
            case "scan_pets": return { pets: [], diagnostics: [], codexBundles: [] };
            case "hook_status":
            case "install_hooks": return hookStatus(String(args.agent ?? "codex"));
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

test("switches between the three settings pages and agent details", async ({ page }) => {
  await page.goto("/settings.html");
  await expect(page.locator("#current-version")).toHaveText("v1.1.0");
  await expect(page.locator('[data-settings-panel="general"]')).toBeVisible();
  await expect(page.locator("[data-settings-page]")).toHaveCount(3);
  await expect(page.locator('[data-settings-panel="general"] .section-heading-actions #open-debug')).toBeVisible();
  await expect(page.locator('[data-settings-panel="general"] #codex-link')).toHaveCount(0);
  await expect(page.locator('[data-settings-panel="general"] #claude-code-link')).toHaveCount(0);
  await expect(page.locator('[data-agent-panel="codex"] #open-debug')).toHaveCount(0);

  await page.getByRole("tab", { name: /智能体/ }).click();
  await expect(page).toHaveURL(/#agents\/codex$/);
  await expect(page.locator('[data-settings-panel="agents"]')).toBeVisible();
  await expect(page.locator('[data-agent-panel="codex"]')).toBeVisible();
  await expect(page.locator('[data-settings-panel="general"]')).toBeHidden();
  await expect(page.locator('[data-agent-panel="codex"] .agent-detail-heading #codex-link')).toBeChecked();
  await expect(page.locator('[data-agent-panel="codex"] .agent-detail-heading #codex-link')).toBeEnabled();
  await expect.poll(() => page.locator('[data-agent-settings="codex"] .agent-nav-icon img').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  await expect.poll(() => page.locator('[data-agent-settings="claude-code"] .agent-nav-icon img').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);

  const agentNavigation = await page.locator("#agent-settings-nav").evaluate((navigation) => {
    const buttons = [...navigation.querySelectorAll(":scope > button")];
    return {
      count: buttons.length,
      rows: new Set(buttons.map((button) => Math.round(button.getBoundingClientRect().top))).size,
      overflows: navigation.scrollWidth > navigation.clientWidth,
    };
  });
  expect(agentNavigation).toEqual({ count: 2, rows: 1, overflows: false });
  await expect(page.locator("#codex-integration > .button-row > button")).toHaveCount(4);

  await page.getByRole("tab", { name: /Claude Code/ }).click();
  await expect(page).toHaveURL(/#agents\/claude-code$/);
  await expect(page.locator('[data-agent-panel="claude-code"]')).toBeVisible();
  await expect(page.locator('[data-agent-panel="codex"]')).toBeHidden();
  await expect(page.locator('[data-agent-panel="claude-code"] .agent-detail-heading #claude-code-link')).not.toBeChecked();
  await expect(page.locator('[data-agent-panel="claude-code"] .agent-detail-heading #claude-code-link')).toBeDisabled();
  await expect(page.locator("#claude-code-integration")).toHaveAttribute("data-state", "setup");
  await expect(page.locator("#claude-code-integration-title")).toHaveText("还差一步即可连接 Claude Code");
  await expect(page.locator("#claude-code-integration-badge")).toHaveText("未连接");
  await expect(page.locator('[data-agent-settings="claude-code"] [data-agent-status]')).toHaveText("未连接");

  await page.getByRole("tab", { name: /关于/ }).click();
  await expect(page).toHaveURL(/#about$/);
  await expect(page.locator('[data-settings-panel="about"]')).toBeVisible();
  await expect(page.locator("#settings-page-title")).toHaveText("关于");
});

test("shows Claude global Hook disable instead of a connected state", async ({ page }) => {
  await page.goto("/settings.html#agents/claude-code");
  await page.evaluate(() => {
    const overrides = (window as unknown as {
      __TAURI_TEST_HOOK_STATUS_OVERRIDES__: Record<string, Record<string, unknown>>;
    }).__TAURI_TEST_HOOK_STATUS_OVERRIDES__;
    overrides["claude-code"] = {
      globallyDisabled: true,
      installedEvents: 13,
      message: "Claude Code 已全局禁用所有 Hooks",
    };
  });

  await page.locator("#install-claude-code-hook").click();
  await expect(page.locator("#claude-code-integration-title")).toHaveText("Claude Code 已全局禁用所有 Hooks");
  await expect(page.locator("#claude-code-integration-badge")).toHaveText("全局禁用");
  await expect(page.locator("#claude-code-link")).toBeDisabled();
  await expect(page.locator("#claude-code-hook-status")).toHaveClass("status-error");
  await expect(page.locator("#settings-message")).toContainText("disableAllHooks");
});

test("shows native pet directory paths and opens the default directory", async ({ page }) => {
  await page.goto("/settings.html");
  await expect(page.locator("#extra-directory")).toHaveAttribute(
    "placeholder",
    "C:\\Users\\Tester\\Downloads\\codex-pets",
  );
  const open = page.getByRole("button", { name: "打开宠物目录" });
  await expect(open).toHaveAttribute("title", "C:\\Users\\Tester\\.codex\\pets");
  await open.click();
  await expect.poll(() => page.evaluate(() => (
    window as unknown as { __TAURI_TEST_COMMANDS__: string[] }
  ).__TAURI_TEST_COMMANDS__)).toContain("reveal_pet_directory");
});

test("switches languages without translating language names or native paths", async ({ page }) => {
  await page.goto("/settings.html");
  const language = page.locator("#language");
  const directory = page.locator("#extra-directory");

  await language.selectOption("en");
  await expect(page.getByRole("heading", { name: "General" })).toBeVisible();
  await expect(language.locator('option[value="system"]')).toHaveText("Follow system");
  await expect(language.locator('option[value="cn"]')).toHaveText("简体中文");
  await expect(language.locator('option[value="en"]')).toHaveText("English");
  await expect(directory).toHaveAttribute("placeholder", "C:\\Users\\Tester\\Downloads\\codex-pets");

  await language.selectOption("cn");
  await expect(page.getByRole("heading", { name: "通用" })).toBeVisible();
  await expect(language.locator('option[value="system"]')).toHaveText("跟随系统");
  await expect(language.locator('option[value="cn"]')).toHaveText("简体中文");
  await expect(language.locator('option[value="en"]')).toHaveText("English");
  await expect(directory).toHaveAttribute("placeholder", "C:\\Users\\Tester\\Downloads\\codex-pets");
});

test("shows an error when the default pet directory cannot be opened", async ({ page }) => {
  await page.goto("/settings.html");
  await page.evaluate(() => (
    window as unknown as { __TAURI_TEST_FAILED_COMMANDS__: Set<string> }
  ).__TAURI_TEST_FAILED_COMMANDS__.add("reveal_pet_directory"));
  await page.getByRole("button", { name: "打开宠物目录" }).click();
  await expect(page.locator("#settings-message")).toContainText("无法打开宠物目录");
});

test("keeps a persisted update indicator visible while the update is available", async ({ page }) => {
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
  await expect(page.locator("#about-update-dot")).toBeVisible();
  await expect(page.locator("#update-status-title")).toHaveText("发现新版本 v1.2.0");
  await expect(page.getByRole("button", { name: "下载更新" })).toBeVisible();
});

test("keeps the sidebar fixed and renders the app and navigation icons", async ({ page }) => {
  await page.goto("/settings.html#about");
  await expect.poll(() => page.locator(".settings-brand-mark").evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  await expect.poll(() => page.locator(".about-logo").evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  await expect(page.locator('[data-settings-page="general"] [data-icon="settings"] svg')).toBeVisible();
  await expect(page.locator('[data-settings-page="agents"] [data-icon="bot"] svg')).toBeVisible();
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
  await expect(page.locator("#about-update-dot")).toBeVisible();
  await page.getByRole("button", { name: "安装并重启" }).click();
  await expect.poll(() => page.evaluate(() => (
    window as unknown as { __TAURI_TEST_COMMANDS__: string[] }
  ).__TAURI_TEST_COMMANDS__)).toContain("plugin:updater|install");
  await expect(page.locator("#about-update-dot")).toBeHidden();
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
