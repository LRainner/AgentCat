import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LiveStatusController } from "./live-status";
import type { AgentEvent, AgentLiveStatus, AppConfig } from "./types";

const statusWindow = getCurrentWindow();
const root = document.querySelector<HTMLElement>("#live-status")!;
let config: AppConfig;
let lastEventKey = "";
let expanded = false;
let renderQueue = Promise.resolve();

const COLLAPSED_HEIGHT = 96;
const COLLAPSED_OFFSET = 8;
const EXPANDED_OFFSET = 80;

function contentHeight(count: number): number {
  if (count <= 1) return COLLAPSED_HEIGHT;
  return COLLAPSED_HEIGHT + (count - 1) * (expanded ? EXPANDED_OFFSET : COLLAPSED_OFFSET);
}

async function render(statuses: AgentLiveStatus[]): Promise<void> {
  if (!statuses.length || !config?.codex.hooksEnabled || !config.codex.showLiveStatus) {
    expanded = false;
    root.hidden = true;
    await statusWindow.hide();
    return;
  }

  if (statuses.length === 1) expanded = false;
  const existingCards = new Map(
    [...root.querySelectorAll<HTMLElement>(".status-card")].map((card) => [card.dataset.sessionId ?? "", card]),
  );
  const activeIds = new Set(statuses.map(({ sessionId }) => sessionId));
  for (const [sessionId, card] of existingCards) {
    if (!activeIds.has(sessionId)) card.remove();
  }

  statuses.forEach((status, index) => {
    let card = existingCards.get(status.sessionId);
    if (!card) {
      card = document.createElement("article");
      card.className = "status-card";
      card.dataset.sessionId = status.sessionId;
      card.innerHTML = `
        <div class="status-card-surface">
          <div class="status-copy">
            <div class="status-title"></div>
            <div class="status-detail"></div>
          </div>
          <span class="status-indicator" aria-hidden="true"></span>
        </div>`;
      root.append(card);
    }
    card.dataset.phase = status.phase;
    card.style.setProperty("--stack-collapsed-y", `${-index * COLLAPSED_OFFSET}px`);
    card.style.setProperty("--stack-expanded-y", `${-index * EXPANDED_OFFSET}px`);
    card.style.setProperty("--stack-scale", String(Math.max(0.94, 1 - index * 0.012)));
    card.style.zIndex = String(statuses.length - index);
    card.querySelector<HTMLElement>(".status-title")!.textContent = config.codex.showTaskSummary ? status.title : "Codex";
    card.querySelector<HTMLElement>(".status-detail")!.textContent = status.detail;
  });

  root.dataset.expanded = String(expanded);
  root.setAttribute("aria-expanded", String(expanded));
  root.setAttribute("aria-label", statuses.length > 1
    ? `${statuses.length} 个 Codex 会话，点击${expanded ? "收起" : "展开"}`
    : "1 个 Codex 会话");
  const height = contentHeight(statuses.length);
  root.style.setProperty("--content-height", `${height}px`);
  root.hidden = false;
  await invoke("sync_status_window", { contentHeight: height });
  await statusWindow.show();
}

function queueRender(statuses = controller.getStatuses()): void {
  renderQueue = renderQueue.then(() => render(statuses)).catch(() => undefined);
}

const controller = new LiveStatusController((statuses) => queueRender(statuses));

function acceptEvent(payload: AgentEvent): void {
  const key = [payload.sessionId, payload.event, payload.timestamp, payload.title ?? "", payload.toolName ?? ""].join(":");
  if (key === lastEventKey) return;
  lastEventKey = key;
  if (config?.codex.hooksEnabled && config.codex.showLiveStatus) controller.setAgentEvent(payload);
}

async function loadConfig(): Promise<void> {
  config = await invoke<AppConfig>("get_config");
  applyConfigStyles();
  await render(controller.getStatuses());
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
  queueRender();
});
void listen("agent-cat-config-changed", () => void loadConfig());
window.addEventListener("beforeunload", () => controller.dispose());
root.addEventListener("click", () => {
  if (controller.getStatuses().length < 2) return;
  expanded = !expanded;
  queueRender();
});
root.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  root.click();
});
void loadConfig();
window.setInterval(async () => {
  try {
    const event = await invoke<AgentEvent | null>("get_live_event");
    if (event) acceptEvent(event);
  } catch { /* Event push remains the fast path if polling is unavailable. */ }
}, 350);
