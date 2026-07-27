import type { AgentEvent, AgentLiveStatus, AgentStatusPhase } from "./types";

const ACTIVE_TIMEOUT_MS = 120_000;
const TRANSIENT_TIMEOUT_MS = 8_000;

export function sanitizeStatusText(value: string | undefined, maxCharacters = 80): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  const characters = Array.from(normalized);
  return characters.length <= maxCharacters ? normalized : `${characters.slice(0, maxCharacters - 1).join("")}…`;
}

function toolDetail(event: string, toolName?: string): string {
  const completed = event === "PostToolUse";
  switch (toolName) {
    case "Bash": return completed ? "正在检查命令结果" : "正在执行命令";
    case "apply_patch": return completed ? "正在检查代码修改" : "正在修改代码";
    case "update_plan": return completed ? "任务计划已更新" : "正在更新任务计划";
    case "spawn_agent":
    case "Agent": return completed ? "正在汇总协作结果" : "正在分配协作任务";
    case "view_image": return completed ? "正在分析图片" : "正在查看图片";
    default:
      if (toolName?.startsWith("mcp__")) return completed ? "正在处理外部工具结果" : "正在使用外部工具";
      return completed ? "正在处理工具结果" : "正在使用工具";
  }
}

function eventPresentation(payload: AgentEvent): { phase: AgentStatusPhase; detail: string; transient?: boolean } | null {
  switch (payload.event) {
    case "SessionStart": return { phase: "starting", detail: "会话已开始", transient: true };
    case "UserPromptSubmit": return { phase: "thinking", detail: "正在理解任务" };
    case "PreToolUse": return { phase: "tool", detail: toolDetail(payload.event, payload.toolName) };
    case "PostToolUse": return { phase: "thinking", detail: toolDetail(payload.event, payload.toolName) };
    case "SubagentStart": return { phase: "tool", detail: "正在协作处理" };
    case "SubagentStop": return { phase: "thinking", detail: "正在汇总协作结果" };
    case "PreCompact": return { phase: "thinking", detail: "正在整理上下文" };
    case "PostCompact": return { phase: "thinking", detail: "正在继续任务" };
    case "PermissionRequest": return { phase: "waiting", detail: "等待你的确认" };
    case "Stop": return { phase: "done", detail: "任务完成", transient: true };
    case "HookParseError": return { phase: "error", detail: "无法解析 Codex 状态", transient: true };
    default: return null;
  }
}

export class LiveStatusController {
  private readonly titles = new Map<string, string>();
  private readonly latestEvents = new Map<string, { timestamp: number; keys: Set<string> }>();
  private readonly sessions = new Map<string, {
    status: AgentLiveStatus;
    hideTimer: ReturnType<typeof globalThis.setTimeout>;
    updateOrder: number;
  }>();
  private updateOrder = 0;

  constructor(private readonly onChange: (statuses: AgentLiveStatus[]) => void) {}

  setAgentEvent(payload: AgentEvent): void {
    const presentation = eventPresentation(payload);
    if (!presentation) return;
    const eventKey = [payload.sessionId, payload.event, payload.timestamp, payload.title ?? "", payload.toolName ?? ""].join(":");
    const previous = this.sessions.get(payload.sessionId);
    const latestEvent = this.latestEvents.get(payload.sessionId);
    if (latestEvent && (payload.timestamp < latestEvent.timestamp || latestEvent.keys.has(eventKey))) return;

    const latestEventKeys = payload.timestamp === latestEvent?.timestamp
      ? latestEvent.keys
      : new Set<string>();
    latestEventKeys.add(eventKey);
    this.latestEvents.set(payload.sessionId, { timestamp: payload.timestamp, keys: latestEventKeys });

    const suppliedTitle = sanitizeStatusText(payload.title);
    if (suppliedTitle) this.titles.set(payload.sessionId, suppliedTitle);
    const title = payload.event === "HookParseError"
      ? "Codex 状态更新失败"
      : this.titles.get(payload.sessionId) ?? (payload.event === "SessionStart" ? "Codex" : "Codex 任务");

    const status: AgentLiveStatus = {
      sessionId: payload.sessionId,
      phase: presentation.phase,
      title,
      detail: presentation.detail,
      timestamp: payload.timestamp,
    };
    if (previous) globalThis.clearTimeout(previous.hideTimer);
    const hideTimer = globalThis.setTimeout(
      () => this.clear(payload.sessionId),
      presentation.transient ? TRANSIENT_TIMEOUT_MS : ACTIVE_TIMEOUT_MS,
    );
    this.sessions.set(payload.sessionId, {
      status,
      hideTimer,
      updateOrder: ++this.updateOrder,
    });
    this.emitChange();
  }

  getStatuses(): AgentLiveStatus[] {
    return [...this.sessions.values()]
      .sort((left, right) => right.updateOrder - left.updateOrder)
      .map(({ status }) => status);
  }

  clear(sessionId?: string): void {
    if (sessionId) {
      const session = this.sessions.get(sessionId);
      if (!session) return;
      globalThis.clearTimeout(session.hideTimer);
      this.sessions.delete(sessionId);
    } else {
      for (const session of this.sessions.values()) globalThis.clearTimeout(session.hideTimer);
      this.sessions.clear();
    }
    this.emitChange();
  }

  dispose(): void {
    this.clear();
    this.titles.clear();
    this.latestEvents.clear();
    this.updateOrder = 0;
  }

  private emitChange(): void {
    this.onChange(this.getStatuses());
  }
}
