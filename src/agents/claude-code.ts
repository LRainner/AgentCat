import type { AgentAdapter, AgentEventName } from "./types";

const EVENTS = new Set<AgentEventName>([
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "PostCompact",
  "PermissionRequest",
  "Stop",
  "StopFailure",
  "TurnInterrupted",
  "SessionEnd",
  "HookParseError",
]);

export const claudeCodeAdapter: AgentAdapter = {
  id: "claude-code",
  displayName: "Claude Code",
  normalize(event) {
    if (event.version !== 1 || event.agent !== "claude-code" || !EVENTS.has(event.event as AgentEventName)) return null;
    return { ...event, version: 1, event: event.event as AgentEventName };
  },
  isEnabled: (config) => config.claudeCode.hooksEnabled,
  showsLiveStatus: (config) => config.claudeCode.hooksEnabled && config.claudeCode.showLiveStatus,
  showsTaskSummary: (config) => config.claudeCode.showTaskSummary,
};
