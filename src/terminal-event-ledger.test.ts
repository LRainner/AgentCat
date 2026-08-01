import { describe, expect, it } from "vitest";
import {
  MAX_TERMINAL_SESSIONS,
  MAX_TERMINAL_TURNS,
  TerminalEventLedger,
} from "./terminal-event-ledger";
import type { AgentEvent } from "./types";
import type { AgentEventName } from "./agents";

function event(sessionId: string, turnId: string, name: AgentEventName, timestamp: number): AgentEvent {
  return { version: 1, agent: "codex", sessionId, turnId, event: name, timestamp };
}

describe("TerminalEventLedger", () => {
  it("bounds terminal session and turn tombstones", () => {
    const ledger = new TerminalEventLedger();
    for (let index = 0; index <= Math.max(MAX_TERMINAL_SESSIONS, MAX_TERMINAL_TURNS); index += 1) {
      const terminal = event(`session-${index}`, `turn-${index}`, "TurnInterrupted", index);
      ledger.recordTurn(terminal);
    }

    expect(ledger.shouldIgnore(event("session-0", "turn-0", "PostToolUse", 1_000))).toBe(false);
    const newest = Math.max(MAX_TERMINAL_SESSIONS, MAX_TERMINAL_TURNS);
    expect(ledger.shouldIgnore(event(`session-${newest}`, `turn-${newest}`, "PostToolUse", 1_000))).toBe(true);
  });

  it("keeps an ended session closed until a new session start", () => {
    const ledger = new TerminalEventLedger();
    ledger.recordSessionEnd(event("session", "turn-1", "SessionEnd", 2));
    expect(ledger.shouldIgnore(event("session", "turn-2", "PostToolUse", 3))).toBe(true);
    const resumed = {
      ...event("session", "turn-1", "SessionStart", 4),
      sessionSource: "resume",
    };
    expect(ledger.shouldIgnore(resumed)).toBe(false);
    ledger.recordActivity(resumed);
    expect(ledger.shouldIgnore(event("session", "turn-1", "PostToolUse", 5))).toBe(false);
  });

  it("rejects an old turn interruption after a new turn starts", () => {
    const ledger = new TerminalEventLedger();
    ledger.recordActivity(event("session", "turn-1", "PreToolUse", 1));
    ledger.recordActivity(event("session", "turn-2", "UserPromptSubmit", 2));
    expect(ledger.shouldIgnore(event("session", "turn-1", "TurnInterrupted", 3))).toBe(true);
    expect(ledger.shouldIgnore(event("session", "turn-2", "PostToolUse", 4))).toBe(false);
  });

  it("allows a new prompt to reopen an ended session when session start was missed", () => {
    const ledger = new TerminalEventLedger();
    ledger.recordSessionEnd(event("session", "turn-1", "SessionEnd", 1));
    const prompt = event("session", "turn-2", "UserPromptSubmit", 2);
    expect(ledger.shouldIgnore(prompt)).toBe(false);
    ledger.recordActivity(prompt);
    expect(ledger.shouldIgnore(event("session", "turn-2", "PreToolUse", 3))).toBe(false);
  });
});
