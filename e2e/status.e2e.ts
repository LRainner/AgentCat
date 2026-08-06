import { expect, test, type Page } from "@playwright/test";

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
    bubbleOpacity: 0.92,
  },
  claudeCode: { hooksEnabled: true, showLiveStatus: true, showTaskSummary: true },
};

const events = [
  {
    version: 1,
    agent: "codex",
    sessionId: "codex-session",
    event: "PreToolUse",
    timestamp: 1,
    title: "检查 Codex 改动",
    toolName: "Bash",
  },
  {
    version: 1,
    agent: "claude-code",
    sessionId: "claude-session",
    event: "PermissionRequest",
    timestamp: 2,
    title: "确认 Claude Code 操作",
  },
];

async function mockStatusWindow(page: Page, mockConfig = config): Promise<void> {
  await page.addInitScript(({ mockConfig, mockEvents }) => {
    let callbackId = 0;
    let eventIndex = 0;
    const callbacks = new Map<number, (...args: unknown[]) => unknown>();
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      value: {
        metadata: {
          currentWindow: { label: "status" },
          currentWebview: { label: "status" },
          windows: [{ label: "status" }],
          webviews: [{ label: "status", windowLabel: "status" }],
        },
        transformCallback(callback: (...args: unknown[]) => unknown) {
          callbackId += 1;
          callbacks.set(callbackId, callback);
          return callbackId;
        },
        unregisterCallback(id: number) { callbacks.delete(id); },
        async invoke(command: string) {
          switch (command) {
            case "get_config": return structuredClone(mockConfig);
            case "get_live_event": return structuredClone(mockEvents[eventIndex++] ?? null);
            case "sync_status_window":
            case "plugin:event|listen":
            case "plugin:window|show":
            case "plugin:window|hide": return null;
            default: return null;
          }
        },
      },
      configurable: true,
    });
  }, { mockConfig, mockEvents: events });
}

test("shows each agent source immediately to the left of its status indicator", async ({ page }) => {
  await mockStatusWindow(page);
  await page.goto("/status.html");
  await expect(page.locator(".status-card")).toHaveCount(2);

  for (const [sessionId, source] of [
    ["codex-session", "Codex"],
    ["claude-session", "Claude Code"],
  ] as const) {
    const card = page.locator(`.status-card[data-session-id="${sessionId}"]`);
    const sourceLabel = card.locator(".status-source");
    const indicator = card.locator(".status-indicator");
    await expect(sourceLabel).toHaveText(source);

    const sourceBox = await sourceLabel.boundingBox();
    const indicatorBox = await indicator.boundingBox();
    expect(sourceBox).not.toBeNull();
    expect(indicatorBox).not.toBeNull();
    expect(sourceBox!.x + sourceBox!.width).toBeLessThan(indicatorBox!.x);
    expect(sourceBox!.y).toBeGreaterThan(indicatorBox!.y + indicatorBox!.height / 2);
  }
});

test("does not repeat the agent source when task summaries are hidden", async ({ page }) => {
  await mockStatusWindow(page, {
    ...config,
    codex: { ...config.codex, showTaskSummary: false },
  });
  await page.goto("/status.html");

  const card = page.locator('.status-card[data-session-id="codex-session"]');
  await expect(card.locator(".status-title")).toHaveText("Codex");
  await expect(card.locator(".status-source")).toBeHidden();
});
