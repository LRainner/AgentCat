import type { AgentAdapter, AgentEventName } from "./types";

const EVENTS = new Set<AgentEventName>([
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
  "PreCompact",
  "PostCompact",
  "Stop",
  "StopFailure",
  "TurnInterrupted",
  "SessionEnd",
  "HookParseError",
]);

export const dshAdapter: AgentAdapter = {
  id: "dsh",
  displayName: "DeepSeek Harness",
  normalize(event) {
    if (event.version !== 1 || event.agent !== "dsh" || !EVENTS.has(event.event as AgentEventName)) return null;
    return { ...event, version: 1, event: event.event as AgentEventName };
  },
  isEnabled: (config) => config.dsh.hooksEnabled,
  showsLiveStatus: (config) => config.dsh.hooksEnabled && config.dsh.showLiveStatus,
  showsTaskSummary: (config) => config.dsh.showTaskSummary,
};
