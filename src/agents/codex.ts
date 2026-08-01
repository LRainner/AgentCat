import type { AgentAdapter, AgentEventName } from "./types";

const EVENTS = new Set<AgentEventName>([
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "PostCompact",
  "PermissionRequest",
  "Stop",
  "TurnInterrupted",
  "SessionEnd",
  "HookParseError",
]);

export const codexAdapter: AgentAdapter = {
  id: "codex",
  displayName: "Codex",
  normalize(event) {
    if (event.version !== 1 || event.agent !== "codex" || !EVENTS.has(event.event as AgentEventName)) return null;
    return { ...event, version: 1, event: event.event as AgentEventName };
  },
  isEnabled: (config) => config.codex.hooksEnabled,
  showsLiveStatus: (config) => config.codex.hooksEnabled && config.codex.showLiveStatus,
  showsTaskSummary: (config) => config.codex.showTaskSummary,
};
