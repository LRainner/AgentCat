import { describe, expect, it } from "vitest";
import type { AppConfig } from "../types";
import { codexAdapter } from "./codex";
import { claudeCodeAdapter } from "./claude-code";
import { dshAdapter } from "./dsh";
import { AgentAdapterRegistry } from "./registry";
import type { AgentAdapter, RawAgentEvent } from "./types";

const config = {
  codex: { hooksEnabled: true, showLiveStatus: true, showTaskSummary: true },
  claudeCode: { hooksEnabled: true, showLiveStatus: true, showTaskSummary: true },
  dsh: { hooksEnabled: true, showLiveStatus: true, showTaskSummary: true },
} as AppConfig;

function raw(agent: string, event: string): RawAgentEvent {
  return { version: 1, agent, sessionId: "shared-session", event, timestamp: 1 };
}

describe("AgentAdapterRegistry", () => {
  it("normalizes supported Codex events and rejects invalid or unknown input", () => {
    const registry = new AgentAdapterRegistry([codexAdapter]);
    expect(registry.normalize(raw("codex", "PreToolUse"))?.event).toBe("PreToolUse");
    expect(registry.normalize({ ...raw("codex", "PreToolUse"), version: 2 })).toBeNull();
    expect(registry.normalize(raw("unknown", "PreToolUse"))).toBeNull();
  });

  it("adds another agent without changing event consumers", () => {
    const secondAgent: AgentAdapter = {
      id: "second-agent",
      displayName: "Second Agent",
      normalize(event) {
        if (event.version !== 1 || event.agent !== this.id || event.event !== "tool.started") return null;
        return { ...event, version: 1, event: "PreToolUse", toolName: "custom-tool" };
      },
      isEnabled: () => true,
      showsLiveStatus: () => true,
      showsTaskSummary: () => false,
    };
    const registry = new AgentAdapterRegistry([codexAdapter, secondAgent]);
    const normalized = registry.normalize(raw("second-agent", "tool.started"));
    expect(normalized).toMatchObject({
      agent: "second-agent",
      sessionId: "shared-session",
      event: "PreToolUse",
      toolName: "custom-tool",
    });
    expect(registry.displayName("second-agent")).toBe("Second Agent");
    expect(registry.isEnabled(config, "second-agent")).toBe(true);
    expect(registry.showsLiveStatus(config, "second-agent")).toBe(true);
    expect(registry.showsTaskSummary(config, "second-agent")).toBe(false);
  });

  it("normalizes Claude Code failure events independently", () => {
    const registry = new AgentAdapterRegistry([codexAdapter, claudeCodeAdapter]);
    expect(registry.normalize(raw("claude-code", "PostToolUseFailure"))?.event).toBe("PostToolUseFailure");
    expect(registry.displayName("claude-code")).toBe("Claude Code");
    expect(registry.showsLiveStatus(config, "claude-code")).toBe(true);
  });

  it("accepts transcript-derived Claude Code interruptions", () => {
    const registry = new AgentAdapterRegistry([codexAdapter, claudeCodeAdapter]);
    expect(registry.normalize(raw("claude-code", "TurnInterrupted"))?.event).toBe("TurnInterrupted");
  });

  it("normalizes DeepSeek Harness events through the dsh adapter", () => {
    const registry = new AgentAdapterRegistry([dshAdapter]);
    expect(registry.normalize(raw("dsh", "SessionStart"))?.event).toBe("SessionStart");
    expect(registry.normalize(raw("dsh", "PostToolUseFailure"))?.event).toBe("PostToolUseFailure");
    expect(registry.normalize(raw("dsh", "StopFailure"))?.event).toBe("StopFailure");
    expect(registry.normalize(raw("dsh", "TurnInterrupted"))?.event).toBe("TurnInterrupted");
    expect(registry.normalize(raw("dsh", "UnknownEvent"))).toBeNull();
    expect(registry.displayName("dsh")).toBe("DeepSeek Harness");
    expect(registry.showsLiveStatus(config, "dsh")).toBe(true);
  });

  it("rejects duplicate adapter ids", () => {
    const registry = new AgentAdapterRegistry([codexAdapter]);
    expect(() => registry.register(codexAdapter)).toThrow("Agent adapter already registered: codex");
  });
});
