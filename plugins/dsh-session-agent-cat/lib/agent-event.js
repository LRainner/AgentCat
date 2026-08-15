// The wire shape Agent Cat's local receiver accepts. Fields are serialized in
// camelCase to match the Rust `AgentEvent` (`#[serde(rename_all = "camelCase")]`).

const MAX_TITLE_CHARS = 80;
const MAX_TOOL_NAME_CHARS = 64;

/** Control characters and irregular whitespace normalized to single spaces. */
function sanitizeText(value, maxChars) {
  const normalized = value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ")
    .trim();
  if (!normalized) return undefined;
  const characters = [...normalized];
  return characters.length <= maxChars
    ? normalized
    : `${characters.slice(0, maxChars - 1).join("")}…`;
}

function sanitizeToolName(value) {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text || !/^[A-Za-z0-9_\-:.]+$/.test(text)) return undefined;
  return [...text].length <= MAX_TOOL_NAME_CHARS ? text : undefined;
}

function firstPromptLine(content) {
  if (typeof content !== "string" && !Array.isArray(content)) return undefined;
  const lines = typeof content === "string"
    ? content.split(/\n/)
    : content.flatMap((block) => {
        if (block && typeof block === "object" && "text" in block) {
          const text = block.text;
          return typeof text === "string" ? text.split(/\n/) : [];
        }
        return [];
      });
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("```")) continue;
    const value = trimmed.replace(/^(?:(?:#{1,6}|[>*`-])\s+)+/, "").trim();
    if (!value) continue;
    return sanitizeText(value, MAX_TITLE_CHARS);
  }
  return undefined;
}

function isToolResultError(data) {
  // `tool/result.data.message.content[].isError` is the tool outcome flag.
  const message = data?.message;
  return Array.isArray(message?.content) && message.content.some((block) => block?.isError === true);
}

/**
 * Map one DSH session event to an Agent Cat `AgentEvent`, or null when the
 * event does not map to a state the pet should react to.
 *
 * `toolNames` optionally carries `sessionId\0callId → tool name` pairs so a
 * `tool/result` (which has no tool name of its own) can recover the name of
 * the paired `tool/call`.
 *
 * The mapping only ever reads lifecycle metadata (turn/step identity, event
 * type, tool name, title text). The event's `data` — which carries the full
 * payload including tool arguments, file contents and terminal output — is
 * never copied out of this function, preserving Agent Cat's privacy stance.
 */
export function mapSessionEvent(session, event, toolNames) {
  const sessionId = String(session.id);
  const base = {
    version: 1,
    agent: "dsh",
    sessionId,
    timestamp: event.time,
  };

  switch (event.type) {
    case "turn/start":
      return { ...base, event: "SessionStart" };

    case "user/message": {
      // `UserMessage.source` is a kind-tagged object. Human prompts
      // (`kind: "user"`) and admitted goal continuation rounds
      // (`kind: "goal"`) are real tasks; plugin-injected context
      // (`kind: "plugin"`) must not surface as a task callout.
      const data = event.data;
      const source = data?.source?.kind;
      if (source !== "user" && source !== "goal") return null;
      const title = firstPromptLine(data.content);
      return { ...base, event: "UserPromptSubmit", ...(title ? { title } : {}) };
    }

    case "tool/call": {
      const data = event.data;
      const toolName = sanitizeToolName(data.name);
      // `ask_user_question` blocks the turn until the human answers, so surface
      // it as "waiting for confirmation" rather than an ordinary tool call.
      if (toolName === "ask_user_question") {
        return { ...base, event: "PermissionRequest", toolName };
      }
      return { ...base, event: "PreToolUse", ...(toolName ? { toolName } : {}) };
    }

    case "tool/result": {
      const data = event.data;
      // `tool/result` does not carry the tool name. Recover it from the
      // `tool/call` cache via the `toolCallId` carried by the result block.
      const callId = data?.message?.content?.[0]?.toolCallId;
      const toolName = sanitizeToolName(
        typeof callId === "string" ? toolNames?.get(`${sessionId}\0${callId}`) : undefined,
      );
      const isError = isToolResultError(data);
      return { ...base, event: isError ? "PostToolUseFailure" : "PostToolUse", ...(toolName ? { toolName } : {}) };
    }

    case "approval/asked": {
      // A permission question was put to the user (e.g. a sandbox escalation).
      // Agent Cat's `PermissionRequest` drives the "waiting for confirmation"
      // state.
      const toolName = sanitizeToolName(event.data?.toolName);
      return { ...base, event: "PermissionRequest", ...(toolName ? { toolName } : {}) };
    }

    case "approval/decided": {
      // Only a grant resumes the turn. `rejected`, `cancelled`, and
      // `unavailable` outcomes are followed by their own failing tool result
      // or terminal turn event, so emit nothing here to avoid a misleading
      // "tool completed" bubble.
      if (event.data?.outcome !== "allowed-once") return null;
      return { ...base, event: "PostToolUse" };
    }

    case "turn/end": {
      // Map the turn end reason onto the terminal event vocabulary.
      const data = event.data;
      const reason = data.reason?.kind;
      if (reason === "error") return { ...base, event: "StopFailure" };
      if (reason === "aborted" || reason === "interrupted") return { ...base, event: "TurnInterrupted" };
      if (reason === "blocked" || reason === "max-tokens") return { ...base, event: "StopFailure" };
      return { ...base, event: "Stop" };
    }

    case "compaction/start": {
      // Context compaction begins; surface as Agent Cat's "compacting" state.
      return { ...base, event: "PreCompact" };
    }

    case "compaction/end": {
      // Context compaction finished; resume work.
      return { ...base, event: "PostCompact" };
    }

    default:
      // step/start, step/end, assistant/chunk, assistant/message, todo/write,
      // request/header, request/context, session/end-seed, compaction/summary,
      // approval/policy, sandbox/mode, subagent/descriptor — no pet reaction.
      return null;
  }
}
