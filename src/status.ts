import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LiveStatusController } from "./live-status";
import type { AgentEvent, AgentLiveStatus, AppConfig } from "./types";

const statusWindow = getCurrentWindow();
const root = document.querySelector<HTMLElement>("#live-status")!;
const title = document.querySelector<HTMLElement>("#status-title")!;
const detail = document.querySelector<HTMLElement>("#status-detail")!;
let config: AppConfig;
let lastEventKey = "";

async function render(status: AgentLiveStatus | null): Promise<void> {
  if (!status || !config?.codex.hooksEnabled || !config.codex.showLiveStatus) {
    root.hidden = true;
    await statusWindow.hide();
    return;
  }
  title.textContent = config.codex.showTaskSummary ? status.title : "Codex";
  detail.textContent = status.detail;
  root.dataset.phase = status.phase;
  root.hidden = false;
  await invoke("sync_status_window");
  await statusWindow.show();
}

const controller = new LiveStatusController((status) => { void render(status); });

function acceptEvent(payload: AgentEvent): void {
  const key = [payload.sessionId, payload.event, payload.timestamp, payload.title ?? "", payload.toolName ?? ""].join(":");
  if (key === lastEventKey) return;
  lastEventKey = key;
  if (config?.codex.hooksEnabled && config.codex.showLiveStatus) controller.setAgentEvent(payload);
}

async function loadConfig(): Promise<void> {
  config = await invoke<AppConfig>("get_config");
  applyConfigStyles();
  await render(controller.getCurrent());
}

function applyConfigStyles(): void {
  root.style.setProperty("--bubble-scale", String(Math.min(1.5, Math.max(0.65, config.codex.bubbleScale))));
  root.style.setProperty("--bubble-opacity", String(Math.min(1, Math.max(0.2, config.codex.bubbleOpacity))));
}

void listen<AgentEvent>("codex-event", ({ payload }) => {
  acceptEvent(payload);
});
void listen<AppConfig>("agent-cat-config-preview", ({ payload }) => {
  config = payload;
  applyConfigStyles();
});
void listen("agent-cat-config-changed", () => void loadConfig());
window.addEventListener("beforeunload", () => controller.dispose());
void loadConfig();
window.setInterval(async () => {
  try {
    const event = await invoke<AgentEvent | null>("get_live_event");
    if (event) acceptEvent(event);
  } catch { /* Event push remains the fast path if polling is unavailable. */ }
}, 350);
