import { describe, expect, it } from "vitest";
import { mapSessionEvent } from "./agent-event.js";

function session(id = "session-1") {
  return { id };
}

function event(type, data, time = 42) {
  return { type, seq: 7, time, data };
}

function toolNames(sessionId, entries) {
  return new Map(entries.map(([callId, name]) => [`${sessionId}\0${callId}`, name]));
}

function toolResultData({ callId = "c1", isError = false, text = "ok" } = {}) {
  return {
    turn: 1,
    step: 0,
    message: {
      content: [{
        type: "tool-result",
        toolCallId: callId,
        content: [{ type: "text", text }],
        isError,
      }],
    },
  };
}

describe("mapSessionEvent", () => {
  it("maps turn/start to SessionStart", () => {
    expect(mapSessionEvent(session(), event("turn/start", { turn: 1 }))).toMatchObject({
      agent: "dsh",
      event: "SessionStart",
      sessionId: "session-1",
    });
  });

  it("maps a human user/message to UserPromptSubmit with a sanitized title", () => {
    const mapped = mapSessionEvent(
      session(),
      event("user/message", {
        source: { kind: "user", rpcId: "rpc-1" },
        content: [{ type: "text", text: "  Fix the\n\n live status  " }],
      }),
    );
    // Titles deliberately use only the first non-empty line.
    expect(mapped).toMatchObject({ event: "UserPromptSubmit", title: "Fix the" });
  });

  it("preserves uppercase letters and digits at the start of a title", () => {
    const mapped = mapSessionEvent(
      session(),
      event("user/message", {
        source: { kind: "user" },
        content: [{ type: "text", text: "123 Fix the live status" }],
      }),
    );
    expect(mapped.title).toBe("123 Fix the live status");
  });

  it("strips markdown bullet markers only when followed by whitespace", () => {
    for (const [text, expected] of [
      ["* Bullet point", "Bullet point"],
      ["- Item", "Item"],
      ["# Header", "Header"],
      ["> Quote", "Quote"],
      ["- ## Nested markers", "Nested markers"],
    ]) {
      const mapped = mapSessionEvent(
        session(),
        event("user/message", { source: { kind: "user" }, content: [{ type: "text", text }] }),
      );
      expect(mapped.title).toBe(expected);
    }
  });

  it("preserves non-Markdown prefixes such as #include and -dry-run", () => {
    for (const text of ["#include <stdio.h>", "-dry-run", "*-literal"]) {
      const mapped = mapSessionEvent(
        session(),
        event("user/message", { source: { kind: "user" }, content: [{ type: "text", text }] }),
      );
      expect(mapped.title).toBe(text);
    }
  });

  it("drops agent-injected user/message context", () => {
    expect(
      mapSessionEvent(
        session(),
        event("user/message", {
          source: { kind: "plugin", plugin: "@deepseek-ai/dsh-system-prompt" },
          content: [{ type: "text", text: "Current runtime context snapshot" }],
        }),
      ),
    ).toBeNull();
  });

  it("maps admitted goal continuation rounds as a new task", () => {
    const mapped = mapSessionEvent(
      session(),
      event("user/message", {
        source: { kind: "goal", goalId: "goal-1", revision: 1, round: 2 },
        content: [{ type: "text", text: "Objective: verify the integration fix" }],
      }),
    );
    expect(mapped).toMatchObject({ event: "UserPromptSubmit", title: "Objective: verify the integration fix" });
  });

  it("maps tool/call to PreToolUse with a sanitized tool name", () => {
    expect(
      mapSessionEvent(session(), event("tool/call", { turn: 1, step: 0, callId: "c1", name: "Bash", arguments: "{}" })),
    ).toMatchObject({ event: "PreToolUse", toolName: "Bash" });
  });

  it("maps ask_user_question tool/call to PermissionRequest (waiting for user)", () => {
    expect(
      mapSessionEvent(session(), event("tool/call", { turn: 1, step: 0, callId: "c1", name: "ask_user_question", arguments: "{}" })),
    ).toMatchObject({ event: "PermissionRequest", toolName: "ask_user_question" });
  });

  it("recovers the tool name for a successful tool/result from the callId cache", () => {
    const mapped = mapSessionEvent(
      session(),
      event("tool/result", toolResultData()),
      toolNames("session-1", [["c1", "Bash"]]),
    );
    expect(mapped).toMatchObject({ event: "PostToolUse", toolName: "Bash" });
  });

  it("maps a failing tool/result to PostToolUseFailure with the cached tool name", () => {
    const mapped = mapSessionEvent(
      session(),
      event("tool/result", toolResultData({ isError: true })),
      toolNames("session-1", [["c1", "Bash"]]),
    );
    expect(mapped).toMatchObject({ event: "PostToolUseFailure", toolName: "Bash" });
  });

  it("emits no tool name when the result callId is unknown", () => {
    const mapped = mapSessionEvent(
      session(),
      event("tool/result", toolResultData({ callId: "missing" })),
      toolNames("session-1", [["c1", "Bash"]]),
    );
    expect(mapped).toMatchObject({ event: "PostToolUse" });
    expect(mapped.toolName).toBeUndefined();
  });

  it("maps turn/end reasons to terminal events", () => {
    expect(mapSessionEvent(session(), event("turn/end", { turn: 1, reason: { kind: "completed" } })))
      .toMatchObject({ event: "Stop" });
    expect(mapSessionEvent(session(), event("turn/end", { turn: 1, reason: { kind: "error", error: {} } })))
      .toMatchObject({ event: "StopFailure" });
    expect(mapSessionEvent(session(), event("turn/end", { turn: 1, reason: { kind: "aborted", reason: {} } })))
      .toMatchObject({ event: "TurnInterrupted" });
    expect(mapSessionEvent(session(), event("turn/end", { turn: 1, reason: { kind: "interrupted" } })))
      .toMatchObject({ event: "TurnInterrupted" });
    expect(mapSessionEvent(session(), event("turn/end", { turn: 1, reason: { kind: "blocked" } })))
      .toMatchObject({ event: "StopFailure" });
    expect(mapSessionEvent(session(), event("turn/end", { turn: 1, reason: { kind: "max-tokens" } })))
      .toMatchObject({ event: "StopFailure" });
  });

  it("maps approval/asked and granted approval/decided, ignoring non-grant outcomes", () => {
    expect(mapSessionEvent(session(), event("approval/asked", { id: "a1", toolName: "Bash", callId: "c1" })))
      .toMatchObject({ event: "PermissionRequest", toolName: "Bash" });
    // Real `approval/decided` records carry no tool name, and only a grant
    // resumes the turn.
    const allowed = mapSessionEvent(session(), event("approval/decided", { id: "a1", outcome: "allowed-once" }));
    expect(allowed).toMatchObject({ event: "PostToolUse" });
    expect(allowed.toolName).toBeUndefined();
    for (const outcome of ["rejected", "cancelled", "unavailable"]) {
      expect(mapSessionEvent(session(), event("approval/decided", { id: "a1", outcome }))).toBeNull();
    }
  });

  it("maps compaction/start and compaction/end to PreCompact/PostCompact", () => {
    expect(mapSessionEvent(session(), event("compaction/start", { turn: 1 })))
      .toMatchObject({ event: "PreCompact" });
    expect(mapSessionEvent(session(), event("compaction/end", { turn: 1 })))
      .toMatchObject({ event: "PostCompact" });
  });

  it("marks in-turn compaction as auto and standalone compaction as manual", () => {
    const automatic = { compactionId: "c1", turn: 3 };
    expect(mapSessionEvent(session(), event("compaction/start", automatic)))
      .toMatchObject({ event: "PreCompact", compactTrigger: "auto" });
    expect(mapSessionEvent(session(), event("compaction/end", automatic)))
      .toMatchObject({ event: "PostCompact", compactTrigger: "auto" });

    const standalone = { compactionId: "c2", sourceCommandId: "cmd-1", turn: null };
    expect(mapSessionEvent(session(), event("compaction/start", standalone)))
      .toMatchObject({ event: "PreCompact", compactTrigger: "manual" });
    expect(mapSessionEvent(session(), event("compaction/end", standalone)))
      .toMatchObject({ event: "PostCompact", compactTrigger: "manual" });
  });

  it("produces no reaction for non-mapped event types", () => {
    expect(mapSessionEvent(session(), event("assistant/chunk", { turn: 1, step: 0, chunk: {} }))).toBeNull();
    expect(mapSessionEvent(session(), event("todo/write", { todos: [] }))).toBeNull();
    expect(mapSessionEvent(session(), event("step/start", { turn: 1, step: 0 }))).toBeNull();
  });

  it("never leaks event data into the emitted event", () => {
    const mapped = mapSessionEvent(
      session(),
      event("tool/call", { turn: 1, step: 0, callId: "c1", name: "Bash", arguments: '{"secret": true}' }),
    );
    expect(JSON.stringify(mapped)).not.toContain("secret");

    const result = mapSessionEvent(
      session(),
      event("tool/result", toolResultData({ text: "secret terminal output" })),
      toolNames("session-1", [["c1", "Bash"]]),
    );
    expect(JSON.stringify(result)).not.toContain("secret terminal output");
  });
});
