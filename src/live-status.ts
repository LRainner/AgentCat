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
  private current: AgentLiveStatus | null = null;
  private hideTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private latestEventTimestamp = Number.NEGATIVE_INFINITY;
  private latestEventKeys = new Set<string>();

  constructor(private readonly onChange: (status: AgentLiveStatus | null) => void) {}

  setAgentEvent(payload: AgentEvent): void {
    const presentation = eventPresentation(payload);
    if (!presentation) return;
    const eventKey = [payload.sessionId, payload.event, payload.timestamp, payload.title ?? "", payload.toolName ?? ""].join(":");
    if (payload.timestamp < this.latestEventTimestamp || this.latestEventKeys.has(eventKey)) return;
    if (payload.timestamp > this.latestEventTimestamp) this.latestEventKeys.clear();
    this.latestEventTimestamp = Math.max(this.latestEventTimestamp, payload.timestamp);
    this.latestEventKeys.add(eventKey);

    const suppliedTitle = sanitizeStatusText(payload.title);
    if (suppliedTitle) this.titles.set(payload.sessionId, suppliedTitle);
    const title = payload.event === "HookParseError"
      ? "Codex 状态更新失败"
      : this.titles.get(payload.sessionId) ?? (payload.event === "SessionStart" ? "Codex" : "Codex 任务");

    this.current = {
      sessionId: payload.sessionId,
      phase: presentation.phase,
      title,
      detail: presentation.detail,
      timestamp: payload.timestamp,
    };
    this.onChange(this.current);
    this.armTimeout(presentation.transient ? TRANSIENT_TIMEOUT_MS : ACTIVE_TIMEOUT_MS);
  }

  getCurrent(): AgentLiveStatus | null {
    return this.current;
  }

  clear(): void {
    if (this.hideTimer !== null) globalThis.clearTimeout(this.hideTimer);
    this.hideTimer = null;
    this.current = null;
    this.onChange(null);
  }

  dispose(): void {
    this.clear();
    this.titles.clear();
    this.latestEventTimestamp = Number.NEGATIVE_INFINITY;
    this.latestEventKeys.clear();
  }

  private armTimeout(delay: number): void {
    if (this.hideTimer !== null) globalThis.clearTimeout(this.hideTimer);
    this.hideTimer = globalThis.setTimeout(() => this.clear(), delay);
  }
}
