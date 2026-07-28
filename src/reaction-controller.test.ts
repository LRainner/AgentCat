import { describe, expect, it, vi } from "vitest";
import type { AnimationName } from "./animation-table";
import type { PetRenderer } from "./pet-renderer";
import { ReactionController } from "./reaction-controller";

function harness() {
  const calls: string[] = [];
  let complete: (() => void) | undefined;
  const renderer = {
    play(name: AnimationName, options?: { onComplete?: () => void }) { calls.push(name); complete = options?.onComplete; },
    look(direction: number) { calls.push(`look:${direction}`); },
  } as unknown as PetRenderer;
  return { calls, controller: new ReactionController(renderer), complete: () => complete?.() };
}

describe("ReactionController", () => {
  it("keeps waiting above click reactions and restores it after dragging", () => {
    vi.useFakeTimers();
    const { calls, controller } = harness();
    controller.setAgentEvent({ version: 1, agent: "codex", sessionId: "s", event: "PermissionRequest", timestamp: 1 });
    controller.interact("waving");
    controller.setDragging("right");
    controller.setDragging(null);
    expect(calls).toEqual(["waiting", "runningRight", "waiting"]);
    vi.useRealTimers();
  });

  it("plays the completion sequence then returns to idle", () => {
    vi.useFakeTimers();
    const { calls, controller, complete } = harness();
    controller.setAgentEvent({ version: 1, agent: "codex", sessionId: "s", event: "Stop", timestamp: 1 });
    complete();
    complete();
    expect(calls).toEqual(["review", "jumping", "idle"]);
    vi.useRealTimers();
  });

  it("ignores duplicate and late events after completion", () => {
    vi.useFakeTimers();
    const { calls, controller } = harness();
    const stop = { version: 1, agent: "codex", sessionId: "s", event: "Stop", timestamp: 20 } as const;
    controller.setAgentEvent(stop);
    controller.setAgentEvent(stop);
    controller.setAgentEvent({ version: 1, agent: "codex", sessionId: "s", event: "PreToolUse", timestamp: 10 });
    expect(calls).toEqual(["review"]);
    controller.dispose();
    vi.useRealTimers();
  });

  it("returns stale working state to idle after inactivity", () => {
    vi.useFakeTimers();
    const { calls, controller } = harness();
    controller.setAgentEvent({ version: 1, agent: "codex", sessionId: "s", event: "PreToolUse", timestamp: 1 });
    vi.advanceTimersByTime(120_000);
    expect(calls).toEqual(["running", "idle"]);
    controller.dispose();
    vi.useRealTimers();
  });

  it("keeps working while another session completes", () => {
    vi.useFakeTimers();
    const { calls, controller } = harness();
    controller.setAgentEvent({ version: 1, agent: "codex", sessionId: "s1", event: "PreToolUse", timestamp: 1 });
    controller.setAgentEvent({ version: 1, agent: "codex", sessionId: "s2", event: "PreToolUse", timestamp: 2 });
    controller.setAgentEvent({ version: 1, agent: "codex", sessionId: "s1", event: "Stop", timestamp: 3 });
    expect(calls.at(-1)).toBe("running");
    expect(calls).not.toContain("review");
    controller.dispose();
    vi.useRealTimers();
  });

  it("returns only the interrupted session to idle", () => {
    vi.useFakeTimers();
    const { calls, controller } = harness();
    controller.setAgentEvent({ version: 1, agent: "codex", sessionId: "s1", turnId: "t1", event: "PreToolUse", timestamp: 1 });
    controller.setAgentEvent({ version: 1, agent: "codex", sessionId: "s2", turnId: "t2", event: "PreToolUse", timestamp: 2 });
    controller.setAgentEvent({ version: 1, agent: "codex", sessionId: "s1", turnId: "t1", event: "TurnInterrupted", timestamp: 3 });
    expect(calls.at(-1)).toBe("running");
    controller.setAgentEvent({ version: 1, agent: "codex", sessionId: "s2", turnId: "t2", event: "TurnInterrupted", timestamp: 4 });
    expect(calls.at(-1)).toBe("idle");
    controller.dispose();
    vi.useRealTimers();
  });

  it("does not reactivate an interrupted turn but accepts a different turn", () => {
    vi.useFakeTimers();
    const { calls, controller } = harness();
    controller.setAgentEvent({ version: 1, agent: "codex", sessionId: "s", turnId: "t1", event: "PreToolUse", timestamp: 1 });
    controller.setAgentEvent({ version: 1, agent: "codex", sessionId: "s", turnId: "t1", event: "TurnInterrupted", timestamp: 2 });
    controller.setAgentEvent({ version: 1, agent: "codex", sessionId: "s", turnId: "t1", event: "PostToolUse", timestamp: 3 });
    expect(calls.at(-1)).toBe("idle");
    expect((controller as unknown as { sessions: Map<string, unknown> }).sessions.size).toBe(0);
    controller.setAgentEvent({ version: 1, agent: "codex", sessionId: "s", turnId: "t2", event: "UserPromptSubmit", timestamp: 4 });
    expect(calls.at(-1)).toBe("running");
    controller.dispose();
    vi.useRealTimers();
  });

  it("ignores an old interruption after a new turn starts", () => {
    vi.useFakeTimers();
    const { calls, controller } = harness();
    controller.setAgentEvent({ version: 1, agent: "codex", sessionId: "s", turnId: "t1", event: "PreToolUse", timestamp: 1 });
    controller.setAgentEvent({ version: 1, agent: "codex", sessionId: "s", turnId: "t2", event: "UserPromptSubmit", timestamp: 2 });
    controller.setAgentEvent({ version: 1, agent: "codex", sessionId: "s", turnId: "t1", event: "TurnInterrupted", timestamp: 3 });
    expect(calls.at(-1)).toBe("running");
    controller.dispose();
    vi.useRealTimers();
  });

  it("reset accepts resumed session activity after integration is re-enabled", () => {
    vi.useFakeTimers();
    const { calls, controller } = harness();
    controller.setAgentEvent({ version: 1, agent: "codex", sessionId: "s", turnId: "t1", event: "SessionEnd", timestamp: 1 });
    controller.reset();
    controller.setAgentEvent({ version: 1, agent: "codex", sessionId: "s", turnId: "t2", event: "PreToolUse", timestamp: 2 });
    expect(calls.at(-1)).toBe("running");
    controller.dispose();
    vi.useRealTimers();
  });

  it("removes inactive sessions after their timeout", () => {
    vi.useFakeTimers();
    const { controller } = harness();
    controller.setAgentEvent({ version: 1, agent: "codex", sessionId: "s", event: "PreToolUse", timestamp: 1 });
    vi.advanceTimersByTime(120_000);
    expect((controller as unknown as { sessions: Map<string, unknown> }).sessions.size).toBe(0);
    controller.dispose();
    vi.useRealTimers();
  });

  it("returns manual compaction to idle", () => {
    vi.useFakeTimers();
    const { calls, controller } = harness();
    controller.setAgentEvent({ version: 1, agent: "codex", sessionId: "s", event: "PreCompact", timestamp: 1, compactTrigger: "manual" });
    controller.setAgentEvent({ version: 1, agent: "codex", sessionId: "s", event: "PostCompact", timestamp: 2, compactTrigger: "manual" });
    expect(calls.at(-1)).toBe("idle");
    controller.dispose();
    vi.useRealTimers();
  });
});
