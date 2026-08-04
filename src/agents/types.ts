import type { AppConfig } from "../types";

export const AGENT_EVENT_CHANNEL = "agent-event";

export type AgentEventName =
  | "SessionStart"
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PostToolUse"
  | "PostToolUseFailure"
  | "SubagentStart"
  | "SubagentStop"
  | "PreCompact"
  | "PostCompact"
  | "PermissionRequest"
  | "Stop"
  | "StopFailure"
  | "TurnInterrupted"
  | "SessionEnd"
  | "HookParseError";

export type RawAgentEvent = {
  version: number;
  agent: string;
  sessionId: string;
  event: string;
  timestamp: number;
  title?: string;
  toolName?: string;
  turnId?: string;
  sessionSource?: string;
  compactTrigger?: string;
};

export type AgentEvent = Omit<RawAgentEvent, "version" | "event"> & {
  version: 1;
  event: AgentEventName;
};

export type AgentAdapter = {
  id: string;
  displayName: string;
  normalize: (event: RawAgentEvent) => AgentEvent | null;
  isEnabled: (config: AppConfig) => boolean;
  showsLiveStatus: (config: AppConfig) => boolean;
  showsTaskSummary: (config: AppConfig) => boolean;
};

export function agentSessionKey(event: Pick<AgentEvent, "agent" | "sessionId">): string {
  return `${event.agent}\u0000${event.sessionId}`;
}
