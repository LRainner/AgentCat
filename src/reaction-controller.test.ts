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
});
