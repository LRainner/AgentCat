import type { AgentEvent, AgentLiveStatus, AgentStatusPhase } from "./types";
import { agentEventKey, TerminalEventLedger } from "./terminal-event-ledger";
import { agentDisplayName, agentSessionKey } from "./agents";

const ACTIVE_TIMEOUT_MS = 120_000;
const STALLED_RETENTION_MS = 10 * 60_000;
const SESSION_START_TIMEOUT_MS = 8_000;
const COMPACT_DONE_TIMEOUT_MS = 10_000;
const TASK_DONE_TIMEOUT_MS = 30_000;
const INTERRUPTED_TIMEOUT_MS = 20_000;
const SESSION_END_TIMEOUT_MS = 10_000;
const ERROR_TIMEOUT_MS = 30_000;

type StatusTimeout =
  | { kind: "stale"; afterMs: number }
  | { kind: "hide"; afterMs: number };

type EventPresentation = {
  phase: AgentStatusPhase;
  detail: string;
  timeout: StatusTimeout;
};

export function sanitizeStatusText(value: string | undefined, maxCharacters = 80): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  const characters = Array.from(normalized);
  return characters.length <= maxCharacters ? normalized : `${characters.slice(0, maxCharacters - 1).join("")}…`;
}

function toolDetail(event: string, toolName?: string): string {
  const completed = event === "PostToolUse";
  if (event === "PostToolUseFailure") return toolName
    ? `工具 ${toolName} 执行失败，正在调整方案`
    : "工具执行失败，正在调整方案";
  switch (toolName) {
    case "Bash": return completed ? "Bash 命令执行完成，正在分析结果" : "Bash 命令已开始执行";
    case "apply_patch": return completed ? "代码修改已完成，正在检查结果" : "正在通过 apply_patch 修改代码";
    case "update_plan": return completed ? "任务计划已更新，正在继续任务" : "正在更新任务计划";
    case "spawn_agent":
    case "Agent": return completed ? "协作任务已结束，正在整合结果" : "正在启动子 Agent 协作处理任务";
    case "view_image": return completed ? "图片读取完成，正在分析内容" : "正在读取图片内容";
    default:
      if (toolName?.startsWith("mcp__")) {
        const [, server, ...toolParts] = toolName.split("__");
        const label = server && toolParts.length > 0 ? `${server}/${toolParts.join("/")}` : toolName;
        return completed
          ? `外部工具 ${label} 已完成，正在处理结果`
          : `正在调用外部工具 ${label}`;
      }
      if (toolName) {
        return completed
          ? `工具 ${toolName} 已完成，正在处理结果`
          : `正在调用工具 ${toolName}`;
      }
      return completed ? "工具执行完成，正在处理结果" : "工具已开始执行";
  }
}

function active(phase: AgentStatusPhase, detail: string): EventPresentation {
  return { phase, detail, timeout: { kind: "stale", afterMs: ACTIVE_TIMEOUT_MS } };
}

function transient(phase: AgentStatusPhase, detail: string, afterMs: number): EventPresentation {
  return { phase, detail, timeout: { kind: "hide", afterMs } };
}

function stalledDetail(phase: AgentStatusPhase, agentName: string): string {
  if (phase === "waiting") return `等待确认超过 2 分钟，请检查 ${agentName} 状态`;
  if (phase === "tool") return "工具 2 分钟无更新，可能仍在执行或连接异常";
  return "已 2 分钟无更新，任务可能卡住或连接异常";
}

function eventPresentation(payload: AgentEvent): EventPresentation | null {
  const agentName = agentDisplayName(payload.agent);
  switch (payload.event) {
    case "SessionStart": return payload.sessionSource === "compact"
      ? null
      : transient("starting", `${agentName} 会话已启动，正在等待任务`, SESSION_START_TIMEOUT_MS);
    case "UserPromptSubmit": return active("thinking", "已收到新任务，正在分析需求");
    case "PreToolUse": return active("tool", toolDetail(payload.event, payload.toolName));
    case "PostToolUse": return active("thinking", toolDetail(payload.event, payload.toolName));
    case "PostToolUseFailure": return active("thinking", toolDetail(payload.event, payload.toolName));
    case "SubagentStart": return active("tool", "子 Agent 已启动，正在协作处理任务");
    case "SubagentStop": return active("thinking", "子 Agent 已结束，正在整合协作结果");
    case "PreCompact": return active("thinking", "上下文压缩已开始，正在整理会话");
    case "PostCompact": return payload.compactTrigger === "manual"
      ? transient("done", "手动上下文压缩已完成", COMPACT_DONE_TIMEOUT_MS)
      : active("thinking", "自动上下文压缩已完成，正在继续任务");
    case "PermissionRequest": return active("waiting", `${agentName} 请求操作确认，请返回 ${agentName} 处理`);
    case "Stop": return transient("done", `${agentName} 已完成当前任务`, TASK_DONE_TIMEOUT_MS);
    case "StopFailure": return transient("error", `${agentName} 当前任务因服务错误而结束`, ERROR_TIMEOUT_MS);
    case "SessionEnd": return transient("done", `${agentName} 会话已退出`, SESSION_END_TIMEOUT_MS);
    case "TurnInterrupted": return transient("interrupted", "当前任务已被中断", INTERRUPTED_TIMEOUT_MS);
    case "HookParseError": return transient("error", `Agent Cat 无法解析最新的 ${agentName} 状态`, ERROR_TIMEOUT_MS);
    default: return null;
  }
}

export class LiveStatusController {
  private readonly titles = new Map<string, string>();
  private readonly latestEvents = new Map<string, { timestamp: number; keys: Set<string> }>();
  private readonly terminalEvents = new TerminalEventLedger();
  private readonly sessions = new Map<string, {
    status: AgentLiveStatus;
    timeoutTimer: ReturnType<typeof globalThis.setTimeout>;
    updateOrder: number;
  }>();
  private updateOrder = 0;

  constructor(private readonly onChange: (statuses: AgentLiveStatus[]) => void) {}

  setAgentEvent(payload: AgentEvent): void {
    const presentation = eventPresentation(payload);
    if (!presentation) return;
    const sessionKey = agentSessionKey(payload);
    const eventKey = agentEventKey(payload);
    if (this.terminalEvents.shouldIgnore(payload, eventKey)) return;
    const previous = this.sessions.get(sessionKey);
    const latestEvent = this.latestEvents.get(sessionKey);
    if (latestEvent && (payload.timestamp < latestEvent.timestamp || latestEvent.keys.has(eventKey))) return;

    const latestEventKeys = payload.timestamp === latestEvent?.timestamp
      ? latestEvent.keys
      : new Set<string>();
    latestEventKeys.add(eventKey);
    this.latestEvents.set(sessionKey, { timestamp: payload.timestamp, keys: latestEventKeys });
    this.terminalEvents.recordActivity(payload);
    if (payload.event === "Stop" || payload.event === "StopFailure" || payload.event === "TurnInterrupted") {
      this.terminalEvents.recordTurn(payload, eventKey);
    } else if (payload.event === "SessionEnd") {
      this.terminalEvents.recordSessionEnd(payload, eventKey);
    }

    const suppliedTitle = sanitizeStatusText(payload.title);
    if (suppliedTitle) this.titles.set(sessionKey, suppliedTitle);
    const agentName = agentDisplayName(payload.agent);
    const title = payload.event === "HookParseError"
      ? `${agentName} 状态更新失败`
      : this.titles.get(sessionKey) ?? (payload.event === "SessionStart" ? agentName : `${agentName} 任务`);

    const status: AgentLiveStatus = {
      agent: payload.agent,
      agentName,
      sessionKey,
      sessionId: payload.sessionId,
      phase: presentation.phase,
      title,
      detail: presentation.detail,
      timestamp: payload.timestamp,
    };
    if (previous) globalThis.clearTimeout(previous.timeoutTimer);
    const updateOrder = ++this.updateOrder;
    const timeoutTimer = globalThis.setTimeout(() => {
      if (presentation.timeout.kind === "stale") this.markStalled(sessionKey, updateOrder);
      else this.clearIfCurrent(sessionKey, updateOrder);
    }, presentation.timeout.afterMs);
    this.sessions.set(sessionKey, {
      status,
      timeoutTimer,
      updateOrder,
    });
    this.emitChange();
  }

  getStatuses(): AgentLiveStatus[] {
    return [...this.sessions.values()]
      .sort((left, right) => right.updateOrder - left.updateOrder)
      .map(({ status }) => status);
  }

  clear(sessionKey?: string): void {
    if (sessionKey) {
      const session = this.sessions.get(sessionKey);
      if (!session) return;
      globalThis.clearTimeout(session.timeoutTimer);
      this.sessions.delete(sessionKey);
      this.titles.delete(sessionKey);
      this.latestEvents.delete(sessionKey);
    } else {
      for (const session of this.sessions.values()) globalThis.clearTimeout(session.timeoutTimer);
      this.sessions.clear();
      this.titles.clear();
      this.latestEvents.clear();
    }
    this.emitChange();
  }

  dispose(): void {
    this.reset();
  }

  reset(): void {
    this.clear();
    this.terminalEvents.clear();
    this.updateOrder = 0;
  }

  private emitChange(): void {
    this.onChange(this.getStatuses());
  }

  private markStalled(sessionKey: string, expectedOrder: number): void {
    const current = this.sessions.get(sessionKey);
    if (!current || current.updateOrder !== expectedOrder) return;
    const updateOrder = ++this.updateOrder;
    const timeoutTimer = globalThis.setTimeout(
      () => this.clearIfCurrent(sessionKey, updateOrder),
      STALLED_RETENTION_MS,
    );
    this.sessions.set(sessionKey, {
      status: {
        ...current.status,
        phase: "stalled",
        detail: stalledDetail(current.status.phase, current.status.agentName),
      },
      timeoutTimer,
      updateOrder,
    });
    this.emitChange();
  }

  private clearIfCurrent(sessionKey: string, expectedOrder: number): void {
    if (this.sessions.get(sessionKey)?.updateOrder !== expectedOrder) return;
    this.clear(sessionKey);
  }
}
