import { describe, expect, it, vi } from "vitest";
import { LiveStatusController, sanitizeStatusText } from "./live-status";
import type { AgentEvent, AgentLiveStatus } from "./types";
import type { AgentEventName } from "./agents";

function event(name: AgentEventName, timestamp: number, extras: Partial<AgentEvent> = {}): AgentEvent {
  return { version: 1, agent: "codex", sessionId: "session-1", event: name, timestamp, ...extras };
}

describe("LiveStatusController", () => {
  it("keeps the task summary while the phase changes", () => {
    vi.useFakeTimers();
    const updates: AgentLiveStatus[][] = [];
    const controller = new LiveStatusController((statuses) => updates.push(statuses));
    controller.setAgentEvent(event("UserPromptSubmit", 1, { title: "实现实时状态气泡" }));
    controller.setAgentEvent(event("PreToolUse", 2, { toolName: "apply_patch" }));
    expect(updates.at(-1)?.[0]).toMatchObject({ title: "实现实时状态气泡", detail: "正在通过 apply_patch 修改代码", phase: "tool" });
    controller.dispose();
    vi.useRealTimers();
  });

  it("ignores stale events and keeps task completion visible for thirty seconds", () => {
    vi.useFakeTimers();
    const updates: AgentLiveStatus[][] = [];
    const controller = new LiveStatusController((statuses) => updates.push(statuses));
    controller.setAgentEvent(event("Stop", 20));
    controller.setAgentEvent(event("PreToolUse", 10));
    expect(updates.at(-1)?.[0]?.phase).toBe("done");
    vi.advanceTimersByTime(29_999);
    expect(updates.at(-1)?.[0]?.phase).toBe("done");
    vi.advanceTimersByTime(1);
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
    vi.advanceTimersByTime(30_000);
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
    vi.advanceTimersByTime(15_000);
    controller.setAgentEvent(payload);
    vi.advanceTimersByTime(15_000);
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

  it("keeps identical session ids isolated across agents", () => {
    vi.useFakeTimers();
    const updates: AgentLiveStatus[][] = [];
    const controller = new LiveStatusController((statuses) => updates.push(statuses));
    controller.setAgentEvent(event("PreToolUse", 1));
    controller.setAgentEvent(event("PermissionRequest", 2, { agent: "second-agent" }));
    expect(updates.at(-1)).toHaveLength(2);
    expect(updates.at(-1)?.map(({ agent }) => agent)).toEqual(["second-agent", "codex"]);
    controller.setAgentEvent(event("Stop", 3));
    expect(updates.at(-1)?.find(({ agent }) => agent === "second-agent")?.phase).toBe("waiting");
    controller.dispose();
    vi.useRealTimers();
  });

  it("expires only the completed session", () => {
    vi.useFakeTimers();
    const updates: AgentLiveStatus[][] = [];
    const controller = new LiveStatusController((statuses) => updates.push(statuses));
    controller.setAgentEvent(event("UserPromptSubmit", 1));
    controller.setAgentEvent(event("Stop", 2, { sessionId: "session-2" }));
    vi.advanceTimersByTime(30_000);
    expect(updates.at(-1)?.map(({ sessionId }) => sessionId)).toEqual(["session-1"]);
    controller.dispose();
    vi.useRealTimers();
  });

  it("presents manual compaction, interruption, and session exit as terminal hints", () => {
    vi.useFakeTimers();
    const updates: AgentLiveStatus[][] = [];
    const controller = new LiveStatusController((statuses) => updates.push(statuses));
    controller.setAgentEvent(event("PostCompact", 1, { compactTrigger: "manual" }));
    expect(updates.at(-1)?.[0]).toMatchObject({ phase: "done", detail: "手动上下文压缩已完成" });
    controller.setAgentEvent(event("TurnInterrupted", 2, { turnId: "turn-1" }));
    expect(updates.at(-1)?.[0]).toMatchObject({ phase: "interrupted", detail: "当前任务已被中断" });
    controller.setAgentEvent(event("SessionEnd", 3, { turnId: "turn-1" }));
    expect(updates.at(-1)?.[0]).toMatchObject({ phase: "done", detail: "Codex 会话已退出" });
    vi.advanceTimersByTime(10_000);
    expect(updates.at(-1)).toEqual([]);
    controller.dispose();
    vi.useRealTimers();
  });

  it("preserves automatic compaction status when compact session start arrives", () => {
    vi.useFakeTimers();
    const updates: AgentLiveStatus[][] = [];
    const controller = new LiveStatusController((statuses) => updates.push(statuses));
    controller.setAgentEvent(event("PostCompact", 1, { compactTrigger: "auto" }));
    controller.setAgentEvent(event("SessionStart", 2, { sessionSource: "compact" }));
    expect(updates).toHaveLength(1);
    expect(updates.at(-1)?.[0]).toMatchObject({ phase: "thinking", detail: "自动上下文压缩已完成，正在继续任务" });
    vi.advanceTimersByTime(8_000);
    expect(updates.at(-1)?.[0]?.phase).toBe("thinking");
    controller.dispose();
    vi.useRealTimers();
  });

  it("keeps interruption terminal for the same turn and accepts a new turn", () => {
    vi.useFakeTimers();
    const updates: AgentLiveStatus[][] = [];
    const controller = new LiveStatusController((statuses) => updates.push(statuses));
    controller.setAgentEvent(event("TurnInterrupted", 1, { turnId: "turn-1" }));
    controller.setAgentEvent(event("PostToolUse", 2, { turnId: "turn-1" }));
    expect(updates.at(-1)?.[0]?.phase).toBe("interrupted");
    controller.setAgentEvent(event("UserPromptSubmit", 3, { turnId: "turn-2" }));
    expect(updates.at(-1)?.[0]?.phase).toBe("thinking");
    controller.dispose();
    vi.useRealTimers();
  });

  it("ignores an old interruption after a newer turn is active", () => {
    vi.useFakeTimers();
    const updates: AgentLiveStatus[][] = [];
    const controller = new LiveStatusController((statuses) => updates.push(statuses));
    controller.setAgentEvent(event("PreToolUse", 1, { turnId: "turn-1" }));
    controller.setAgentEvent(event("UserPromptSubmit", 2, { turnId: "turn-2" }));
    controller.setAgentEvent(event("TurnInterrupted", 3, { turnId: "turn-1" }));
    expect(updates.at(-1)?.[0]?.phase).toBe("thinking");
    controller.dispose();
    vi.useRealTimers();
  });

  it("reset clears ended-session tombstones after integration is re-enabled", () => {
    vi.useFakeTimers();
    const updates: AgentLiveStatus[][] = [];
    const controller = new LiveStatusController((statuses) => updates.push(statuses));
    controller.setAgentEvent(event("SessionEnd", 1, { turnId: "turn-1" }));
    controller.reset();
    controller.setAgentEvent(event("PreToolUse", 2, { turnId: "turn-2" }));
    expect(updates.at(-1)?.[0]?.phase).toBe("tool");
    controller.dispose();
    vi.useRealTimers();
  });

  it("shows detailed tool events without exposing tool arguments", () => {
    vi.useFakeTimers();
    const updates: AgentLiveStatus[][] = [];
    const controller = new LiveStatusController((statuses) => updates.push(statuses));
    controller.setAgentEvent(event("PreToolUse", 1, { toolName: "Bash" }));
    expect(updates.at(-1)?.[0]).toMatchObject({ phase: "tool", detail: "Bash 命令已开始执行" });
    controller.setAgentEvent(event("PostToolUse", 2, { toolName: "Bash" }));
    expect(updates.at(-1)?.[0]).toMatchObject({ phase: "thinking", detail: "Bash 命令执行完成，正在分析结果" });
    controller.setAgentEvent(event("PreToolUse", 3, { toolName: "mcp__github__create_pull_request" }));
    expect(updates.at(-1)?.[0]).toMatchObject({ phase: "tool", detail: "正在调用外部工具 github/create_pull_request" });
    controller.dispose();
    vi.useRealTimers();
  });

  it("turns inactive work into a recoverable stalled warning", () => {
    vi.useFakeTimers();
    const updates: AgentLiveStatus[][] = [];
    const controller = new LiveStatusController((statuses) => updates.push(statuses));
    controller.setAgentEvent(event("UserPromptSubmit", 1, { title: "运行较慢的任务", turnId: "turn-1" }));
    vi.advanceTimersByTime(120_000);
    expect(updates.at(-1)?.[0]).toMatchObject({
      title: "运行较慢的任务",
      phase: "stalled",
      detail: "已 2 分钟无更新，任务可能卡住或连接异常",
    });

    controller.setAgentEvent(event("PostToolUse", 2, { toolName: "Bash", turnId: "turn-1" }));
    expect(updates.at(-1)?.[0]).toMatchObject({
      phase: "thinking",
      detail: "Bash 命令执行完成，正在分析结果",
    });

    controller.setAgentEvent(event("PermissionRequest", 3, { turnId: "turn-1" }));
    vi.advanceTimersByTime(120_000);
    expect(updates.at(-1)?.[0]).toMatchObject({
      phase: "stalled",
      detail: "等待确认超过 2 分钟，请检查 Codex 状态",
    });
    controller.dispose();
    vi.useRealTimers();
  });

  it("reclaims a stalled session after the warning retention period", () => {
    vi.useFakeTimers();
    const updates: AgentLiveStatus[][] = [];
    const controller = new LiveStatusController((statuses) => updates.push(statuses));
    controller.setAgentEvent(event("PreToolUse", 1, { toolName: "Bash" }));
    vi.advanceTimersByTime(120_000);
    expect(updates.at(-1)?.[0]).toMatchObject({
      phase: "stalled",
      detail: "工具 2 分钟无更新，可能仍在执行或连接异常",
    });
    vi.advanceTimersByTime(10 * 60_000);
    expect(updates.at(-1)).toEqual([]);
    controller.dispose();
    vi.useRealTimers();
  });
});
