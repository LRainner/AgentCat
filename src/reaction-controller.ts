import type { AnimationName } from "./animation-table";
import { PetRenderer } from "./pet-renderer";
import type { AgentEvent } from "./types";

type BaseState = "idle" | "working" | "waiting";

export class ReactionController {
  private base: BaseState = "idle";
  private dragging: "left" | "right" | null = null;
  private lookDirection: number | null = null;
  private queue: AnimationName[] = [];
  private playingReaction = false;
  private inactivityTimer: number | null = null;
  private latestEventTimestamp = Number.NEGATIVE_INFINITY;
  private latestEventKeys = new Set<string>();

  constructor(private readonly renderer: PetRenderer) {}

  setAgentEvent(payload: AgentEvent): void {
    const eventKey = [payload.sessionId, payload.event, payload.timestamp, payload.title ?? "", payload.toolName ?? ""].join(":");
    if (payload.timestamp < this.latestEventTimestamp || this.latestEventKeys.has(eventKey)) return;
    if (payload.timestamp > this.latestEventTimestamp) this.latestEventKeys.clear();
    this.latestEventTimestamp = Math.max(this.latestEventTimestamp, payload.timestamp);
    this.latestEventKeys.add(eventKey);
    this.armInactivityTimeout();
    switch (payload.event) {
      case "SessionStart":
        this.base = "idle";
        this.replaceQueue(["waving"]);
        break;
      case "UserPromptSubmit":
      case "PreToolUse":
      case "PostToolUse":
      case "SubagentStart":
      case "SubagentStop":
      case "PreCompact":
      case "PostCompact":
        this.base = "working";
        this.queue = [];
        this.playingReaction = false;
        this.render(true);
        break;
      case "PermissionRequest":
        this.base = "waiting";
        this.queue = [];
        this.playingReaction = false;
        this.render(true);
        break;
      case "Stop":
        this.base = "idle";
        this.replaceQueue(["review", "jumping"]);
        break;
      case "HookParseError":
        this.replaceQueue(["failed"]);
        break;
    }
  }

  interact(animation: "waving" | "jumping"): void {
    if (this.base !== "idle" || this.dragging) return;
    this.replaceQueue([animation]);
  }

  setDragging(direction: "left" | "right" | null): void {
    this.dragging = direction;
    this.render(true);
  }

  setLookDirection(direction: number | null): void {
    this.lookDirection = direction;
    if (this.base === "idle" && !this.dragging && !this.playingReaction) this.render();
  }

  refresh(): void { this.render(true); }

  dispose(): void {
    if (this.inactivityTimer !== null) globalThis.clearTimeout(this.inactivityTimer);
    this.inactivityTimer = null;
  }

  private replaceQueue(queue: AnimationName[]): void {
    this.queue = [...queue];
    this.playingReaction = false;
    this.render(true);
  }

  private render(force = false): void {
    if (this.dragging) {
      this.renderer.play(this.dragging === "right" ? "runningRight" : "runningLeft", { force });
      return;
    }
    if (this.base === "waiting") { this.renderer.play("waiting", { force }); return; }
    if (this.base === "working") { this.renderer.play("running", { force }); return; }
    if (this.queue.length > 0) {
      if (this.playingReaction && !force) return;
      const animation = this.queue[0];
      this.playingReaction = true;
      this.renderer.play(animation, { loop: false, force: true, onComplete: () => {
        this.queue.shift();
        this.playingReaction = false;
        this.render(true);
      }});
      return;
    }
    this.playingReaction = false;
    if (this.lookDirection !== null) this.renderer.look(this.lookDirection);
    else this.renderer.play("idle", { force });
  }

  private armInactivityTimeout(): void {
    if (this.inactivityTimer !== null) globalThis.clearTimeout(this.inactivityTimer);
    this.inactivityTimer = globalThis.setTimeout(() => {
      this.base = "idle";
      this.queue = [];
      this.playingReaction = false;
      this.render(true);
    }, 120_000);
  }
}
