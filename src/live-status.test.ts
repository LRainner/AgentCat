import { describe, expect, it, vi } from "vitest";
import { LiveStatusController, sanitizeStatusText } from "./live-status";
import type { AgentEvent, AgentLiveStatus } from "./types";

function event(name: string, timestamp: number, extras: Partial<AgentEvent> = {}): AgentEvent {
  return { version: 1, agent: "codex", sessionId: "session-1", event: name, timestamp, ...extras };
}

describe("LiveStatusController", () => {
  it("keeps the task summary while the phase changes", () => {
    vi.useFakeTimers();
    const updates: AgentLiveStatus[][] = [];
    const controller = new LiveStatusController((statuses) => updates.push(statuses));
    controller.setAgentEvent(event("UserPromptSubmit", 1, { title: "实现实时状态气泡" }));
    controller.setAgentEvent(event("PreToolUse", 2, { toolName: "apply_patch" }));
    expect(updates.at(-1)?.[0]).toMatchObject({ title: "实现实时状态气泡", detail: "正在修改代码", phase: "tool" });
    controller.dispose();
    vi.useRealTimers();
  });

  it("ignores stale events and hides completion after eight seconds", () => {
    vi.useFakeTimers();
    const updates: AgentLiveStatus[][] = [];
    const controller = new LiveStatusController((statuses) => updates.push(statuses));
    controller.setAgentEvent(event("Stop", 20));
    controller.setAgentEvent(event("PreToolUse", 10));
    expect(updates.at(-1)?.[0]?.phase).toBe("done");
    vi.advanceTimersByTime(8_000);
    expect(updates.at(-1)).toEqual([]);
    vi.useRealTimers();
  });

  it("normalizes control characters and limits visible text", () => {
    expect(sanitizeStatusText("  hello\n\tworld  ")).toBe("hello world");
    expect(Array.from(sanitizeStatusText("猫".repeat(100))!).length).toBe(80);
  });

  it("does not resurrect a late event after the completion bubble hides", () => {
    vi.useFakeTimers();
    const updates: AgentLiveStatus[][] = [];
    const controller = new LiveStatusController((statuses) => updates.push(statuses));
    controller.setAgentEvent(event("Stop", 20));
    vi.advanceTimersByTime(8_000);
    controller.setAgentEvent(event("PreToolUse", 10));
    expect(updates.at(-1)).toEqual([]);
    controller.dispose();
    vi.useRealTimers();
  });

  it("ignores an exact duplicate without extending its timeout", () => {
    vi.useFakeTimers();
    const updates: AgentLiveStatus[][] = [];
    const controller = new LiveStatusController((statuses) => updates.push(statuses));
    const payload = event("Stop", 20);
    controller.setAgentEvent(payload);
    vi.advanceTimersByTime(4_000);
    controller.setAgentEvent(payload);
    vi.advanceTimersByTime(4_000);
    expect(updates.at(-1)).toEqual([]);
    controller.dispose();
    vi.useRealTimers();
  });

  it("keeps sessions independently and puts the latest update first", () => {
    vi.useFakeTimers();
    const updates: AgentLiveStatus[][] = [];
    const controller = new LiveStatusController((statuses) => updates.push(statuses));
    controller.setAgentEvent(event("UserPromptSubmit", 10, { title: "第一个任务" }));
    controller.setAgentEvent(event("UserPromptSubmit", 5, { sessionId: "session-2", title: "第二个任务" }));
    expect(updates.at(-1)?.map(({ sessionId }) => sessionId)).toEqual(["session-2", "session-1"]);
    controller.setAgentEvent(event("PreToolUse", 11, { toolName: "Bash" }));
    expect(updates.at(-1)?.map(({ sessionId }) => sessionId)).toEqual(["session-1", "session-2"]);
    controller.dispose();
    vi.useRealTimers();
  });

  it("expires only the completed session", () => {
    vi.useFakeTimers();
    const updates: AgentLiveStatus[][] = [];
    const controller = new LiveStatusController((statuses) => updates.push(statuses));
    controller.setAgentEvent(event("UserPromptSubmit", 1));
    controller.setAgentEvent(event("Stop", 2, { sessionId: "session-2" }));
    vi.advanceTimersByTime(8_000);
    expect(updates.at(-1)?.map(({ sessionId }) => sessionId)).toEqual(["session-1"]);
    controller.dispose();
    vi.useRealTimers();
  });
});
