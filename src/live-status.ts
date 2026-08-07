import type { AgentEvent, AgentLiveStatus, AgentStatusPhase } from "./types";
import { agentEventKey, TerminalEventLedger } from "./terminal-event-ledger";
import { agentDisplayName, agentSessionKey } from "./agents";
import { t } from "./i18n";

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
    ? t("Tool {tool} failed. Adjusting the approach.", { tool: toolName })
    : t("Tool failed. Adjusting the approach.");
  switch (toolName) {
    case "Bash": return completed ? t("Bash command completed. Analyzing the result.") : t("Bash command started");
    case "apply_patch": return completed ? t("Code changes completed. Checking the result.") : t("Modifying code with apply_patch");
    case "update_plan": return completed ? t("Task plan updated. Continuing the task.") : t("Updating the task plan");
    case "spawn_agent":
    case "Agent": return completed ? t("Collaborative task completed. Integrating the result.") : t("Starting a sub-agent to collaborate on the task");
    case "view_image": return completed ? t("Image loaded. Analyzing its contents.") : t("Loading image contents");
    default:
      if (toolName?.startsWith("mcp__")) {
        const [, server, ...toolParts] = toolName.split("__");
        const label = server && toolParts.length > 0 ? `${server}/${toolParts.join("/")}` : toolName;
        return completed
          ? t("External tool {tool} completed. Processing the result.", { tool: label })
          : t("Calling external tool {tool}", { tool: label });
      }
      if (toolName) {
        return completed
          ? t("Tool {tool} completed. Processing the result.", { tool: toolName })
          : t("Calling tool {tool}", { tool: toolName });
      }
      return completed ? t("Tool completed. Processing the result.") : t("Tool started");
  }
}

function active(phase: AgentStatusPhase, detail: string): EventPresentation {
  return { phase, detail, timeout: { kind: "stale", afterMs: ACTIVE_TIMEOUT_MS } };
}

function transient(phase: AgentStatusPhase, detail: string, afterMs: number): EventPresentation {
  return { phase, detail, timeout: { kind: "hide", afterMs } };
}

function stalledDetail(phase: AgentStatusPhase, agentName: string): string {
  if (phase === "waiting") return t("Waiting for confirmation for over 2 minutes. Check {agent}.", { agent: agentName });
  if (phase === "tool") return t("No tool updates for 2 minutes. It may still be running or the connection may have failed.");
  return t("No updates for 2 minutes. The task may be stuck or the connection may have failed.");
}

function eventPresentation(payload: AgentEvent): EventPresentation | null {
  const agentName = agentDisplayName(payload.agent);
  switch (payload.event) {
    case "SessionStart": return payload.sessionSource === "compact"
      ? null
      : transient("starting", t("{agent} session started. Waiting for a task.", { agent: agentName }), SESSION_START_TIMEOUT_MS);
    case "UserPromptSubmit": return active("thinking", t("New task received. Analyzing requirements."));
    case "PreToolUse": return active("tool", toolDetail(payload.event, payload.toolName));
    case "PostToolUse": return active("thinking", toolDetail(payload.event, payload.toolName));
    case "PostToolUseFailure": return active("thinking", toolDetail(payload.event, payload.toolName));
    case "SubagentStart": return active("tool", t("Sub-agent started. Collaborating on the task."));
    case "SubagentStop": return active("thinking", t("Sub-agent completed. Integrating the result."));
    case "PreCompact": return active("thinking", t("Context compaction started. Organizing the session."));
    case "PostCompact": return payload.compactTrigger === "manual"
      ? transient("done", t("Manual context compaction completed"), COMPACT_DONE_TIMEOUT_MS)
      : active("thinking", t("Automatic context compaction completed. Continuing the task."));
    case "PermissionRequest": return active("waiting", t("{agent} requests confirmation. Return to {agent} to respond.", { agent: agentName }));
    case "Stop": return transient("done", t("{agent} completed the current task", { agent: agentName }), TASK_DONE_TIMEOUT_MS);
    case "StopFailure": return transient("error", t("The current {agent} task ended because of a service error", { agent: agentName }), ERROR_TIMEOUT_MS);
    case "SessionEnd": return transient("done", t("{agent} session ended", { agent: agentName }), SESSION_END_TIMEOUT_MS);
    case "TurnInterrupted": return transient("interrupted", t("The current task was interrupted"), INTERRUPTED_TIMEOUT_MS);
    case "HookParseError": return transient("error", t("Agent Cat could not parse the latest {agent} status", { agent: agentName }), ERROR_TIMEOUT_MS);
    default: return null;
  }
}

export class LiveStatusController {
  private readonly titles = new Map<string, string>();
  private readonly latestEvents = new Map<string, { timestamp: number; keys: Set<string> }>();
  private readonly dismissedSessions = new Set<string>();
  private readonly terminalEvents = new TerminalEventLedger();
  private readonly sessions = new Map<string, {
    status: AgentLiveStatus;
    event: AgentEvent;
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
    if (
      payload.event === "UserPromptSubmit"
      || (payload.event === "SessionStart" && payload.sessionSource !== "compact")
    ) {
      this.dismissedSessions.delete(sessionKey);
    }
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
      ? t("{agent} status update failed", { agent: agentName })
      : this.titles.get(sessionKey) ?? (payload.event === "SessionStart" ? agentName : t("{agent} Task", { agent: agentName }));

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
      event: payload,
      timeoutTimer,
      updateOrder,
    });
    this.emitChange();
  }

  getStatuses(): AgentLiveStatus[] {
    return [...this.sessions.values()]
      .filter(({ status }) => !this.dismissedSessions.has(status.sessionKey))
      .sort((left, right) => right.updateOrder - left.updateOrder)
      .map(({ status }) => status);
  }

  dismiss(sessionKey: string): void {
    if (!this.sessions.has(sessionKey) || this.dismissedSessions.has(sessionKey)) return;
    this.dismissedSessions.add(sessionKey);
    this.emitChange();
  }

  refreshLanguage(): void {
    for (const current of this.sessions.values()) {
      const presentation = eventPresentation(current.event);
      if (!presentation) continue;
      const agentName = agentDisplayName(current.event.agent);
      current.status = {
        ...current.status,
        agentName,
        title: current.event.event === "HookParseError"
          ? t("{agent} status update failed", { agent: agentName })
          : this.titles.get(current.status.sessionKey)
            ?? (current.event.event === "SessionStart" ? agentName : t("{agent} Task", { agent: agentName })),
        detail: current.status.phase === "stalled"
          ? stalledDetail(presentation.phase, agentName)
          : presentation.detail,
      };
    }
    this.emitChange();
  }

  clear(sessionKey?: string): void {
    if (sessionKey) {
      const session = this.sessions.get(sessionKey);
      if (!session) return;
      globalThis.clearTimeout(session.timeoutTimer);
      this.sessions.delete(sessionKey);
      this.titles.delete(sessionKey);
      this.latestEvents.delete(sessionKey);
      this.dismissedSessions.delete(sessionKey);
    } else {
      for (const session of this.sessions.values()) globalThis.clearTimeout(session.timeoutTimer);
      this.sessions.clear();
      this.titles.clear();
      this.latestEvents.clear();
      this.dismissedSessions.clear();
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
      event: current.event,
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
