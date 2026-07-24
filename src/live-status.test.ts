import { describe, expect, it, vi } from "vitest";
import { LiveStatusController, sanitizeStatusText } from "./live-status";
import type { AgentEvent, AgentLiveStatus } from "./types";

function event(name: string, timestamp: number, extras: Partial<AgentEvent> = {}): AgentEvent {
  return { version: 1, agent: "codex", sessionId: "session-1", event: name, timestamp, ...extras };
}

describe("LiveStatusController", () => {
  it("keeps the task summary while the phase changes", () => {
    vi.useFakeTimers();
    const updates: Array<AgentLiveStatus | null> = [];
    const controller = new LiveStatusController((status) => updates.push(status));
    controller.setAgentEvent(event("UserPromptSubmit", 1, { title: "实现实时状态气泡" }));
    controller.setAgentEvent(event("PreToolUse", 2, { toolName: "apply_patch" }));
    expect(updates.at(-1)).toMatchObject({ title: "实现实时状态气泡", detail: "正在修改代码", phase: "tool" });
    controller.dispose();
    vi.useRealTimers();
  });

  it("ignores stale events and hides completion after eight seconds", () => {
    vi.useFakeTimers();
    const updates: Array<AgentLiveStatus | null> = [];
    const controller = new LiveStatusController((status) => updates.push(status));
    controller.setAgentEvent(event("Stop", 20));
    controller.setAgentEvent(event("PreToolUse", 10));
    expect(updates.at(-1)?.phase).toBe("done");
    vi.advanceTimersByTime(8_000);
    expect(updates.at(-1)).toBeNull();
    vi.useRealTimers();
  });

  it("normalizes control characters and limits visible text", () => {
    expect(sanitizeStatusText("  hello\n\tworld  ")).toBe("hello world");
    expect(Array.from(sanitizeStatusText("猫".repeat(100))!).length).toBe(80);
  });

  it("does not resurrect a late event after the completion bubble hides", () => {
    vi.useFakeTimers();
    const updates: Array<AgentLiveStatus | null> = [];
    const controller = new LiveStatusController((status) => updates.push(status));
    controller.setAgentEvent(event("Stop", 20));
    vi.advanceTimersByTime(8_000);
    controller.setAgentEvent(event("PreToolUse", 10));
    expect(updates.at(-1)).toBeNull();
    controller.dispose();
    vi.useRealTimers();
  });

  it("ignores an exact duplicate without extending its timeout", () => {
    vi.useFakeTimers();
    const updates: Array<AgentLiveStatus | null> = [];
    const controller = new LiveStatusController((status) => updates.push(status));
    const payload = event("Stop", 20);
    controller.setAgentEvent(payload);
    vi.advanceTimersByTime(4_000);
    controller.setAgentEvent(payload);
    vi.advanceTimersByTime(4_000);
    expect(updates.at(-1)).toBeNull();
    controller.dispose();
    vi.useRealTimers();
  });
});
