import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LiveStatusController } from "./live-status";
import type { AgentLiveStatus, AppConfig } from "./types";
import { agentEventKey } from "./terminal-event-ledger";
import {
  AGENT_EVENT_CHANNEL,
  agentRuntimeSignature,
  normalizeAgentEvent,
  showsAgentLiveStatus,
  showsAgentTaskSummary,
  type RawAgentEvent,
} from "./agents";

const statusWindow = getCurrentWindow();
const shell = document.querySelector<HTMLElement>("#status-shell")!;
const stack = document.querySelector<HTMLElement>("#status-stack")!;
const toggle = document.querySelector<HTMLButtonElement>("#status-toggle")!;
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
  if (!statuses.length) {
    expanded = false;
    shell.hidden = true;
    await statusWindow.hide();
    return;
  }

  if (statuses.length === 1) expanded = false;
  const existingCards = new Map(
    [...stack.querySelectorAll<HTMLElement>(".status-card")].map((card) => [card.dataset.sessionKey ?? "", card]),
  );
  const activeIds = new Set(statuses.map(({ sessionKey }) => sessionKey));
  for (const [sessionKey, card] of existingCards) {
    if (!activeIds.has(sessionKey)) card.remove();
  }

  statuses.forEach((status, index) => {
    let card = existingCards.get(status.sessionKey);
    if (!card) {
      card = document.createElement("article");
      card.className = "status-card";
      card.dataset.sessionKey = status.sessionKey;
      card.dataset.sessionId = status.sessionId;
      card.setAttribute("role", "listitem");
      card.innerHTML = `
        <div class="status-card-surface">
          <div class="status-copy">
            <div class="status-title"></div>
            <div class="status-detail"></div>
          </div>
          <span class="status-indicator" aria-hidden="true"></span>
        </div>`;
      stack.append(card);
    }
    card.dataset.phase = status.phase;
    card.style.setProperty("--stack-collapsed-y", `${-index * COLLAPSED_OFFSET}px`);
    card.style.setProperty("--stack-expanded-y", `${-index * EXPANDED_OFFSET}px`);
    card.style.setProperty("--stack-scale", String(Math.max(0.94, 1 - index * 0.012)));
    card.style.zIndex = String(statuses.length - index);
    card.querySelector<HTMLElement>(".status-title")!.textContent = showsAgentTaskSummary(config, status.agent)
      ? status.title
      : status.agentName;
    card.querySelector<HTMLElement>(".status-detail")!.textContent = status.detail;
  });

  shell.dataset.expanded = String(expanded);
  toggle.hidden = statuses.length < 2;
  toggle.setAttribute("aria-expanded", String(expanded));
  toggle.setAttribute("aria-label", `${statuses.length} 个 Agent 会话，点击${expanded ? "收起" : "展开"}`);
  const height = contentHeight(statuses.length);
  shell.style.setProperty("--content-height", `${height}px`);
  shell.hidden = false;
  await invoke("sync_status_window", { contentHeight: height });
  await statusWindow.show();
}

function queueRender(statuses = controller.getStatuses()): Promise<void> {
  renderQueue = renderQueue.then(() => render(statuses)).catch((error: unknown) => {
    console.error("Failed to render live status", error);
  });
  return renderQueue;
}

const controller = new LiveStatusController((statuses) => queueRender(statuses));

function acceptEvent(payload: RawAgentEvent): void {
  const event = normalizeAgentEvent(payload);
  if (!event) return;
  const key = agentEventKey(event);
  if (key === lastEventKey) return;
  lastEventKey = key;
  if (config && showsAgentLiveStatus(config, event.agent)) controller.setAgentEvent(event);
}

async function loadConfig(): Promise<void> {
  applyConfig(await invoke<AppConfig>("get_config"));
  await queueRender();
}

function applyConfig(next: AppConfig): void {
  const previousSignature = config ? agentRuntimeSignature(config) : null;
  const nextSignature = agentRuntimeSignature(next);
  config = next;
  if (previousSignature !== null && previousSignature !== nextSignature) {
    lastEventKey = "";
    controller.reset();
  }
  applyConfigStyles();
}

function applyConfigStyles(): void {
  shell.style.setProperty("--bubble-scale", String(Math.min(1.5, Math.max(0.65, config.codex.bubbleScale))));
  shell.style.setProperty("--bubble-opacity", String(Math.min(1, Math.max(0.2, config.codex.bubbleOpacity))));
}

void listen<RawAgentEvent>(AGENT_EVENT_CHANNEL, ({ payload }) => {
  acceptEvent(payload);
});
void listen<AppConfig>("agent-cat-config-preview", ({ payload }) => {
  applyConfig(payload);
  queueRender();
});
void listen("agent-cat-config-changed", () => void loadConfig());
window.addEventListener("beforeunload", () => controller.dispose());
toggle.addEventListener("click", () => {
  if (controller.getStatuses().length < 2) return;
  expanded = !expanded;
  queueRender();
});
void loadConfig();
window.setInterval(async () => {
  try {
    const event = await invoke<RawAgentEvent | null>("get_live_event");
    if (event) acceptEvent(event);
  } catch { /* Event push remains the fast path if polling is unavailable. */ }
}, 350);
