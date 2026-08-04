import type { AnimationName } from "./animation-table";
import { PetRenderer } from "./pet-renderer";
import { agentEventKey, TerminalEventLedger } from "./terminal-event-ledger";
import { agentSessionKey } from "./agents";
import type { AgentEvent } from "./types";

const STALLED_RETENTION_MS = 10 * 60_000;

type BaseState = "idle" | "working" | "waiting" | "stalled";
type SessionState = {
  base: BaseState;
  compactResumeBase: BaseState | null;
  inactivityTimer: number | null;
  latestEventTimestamp: number;
  latestEventKeys: Set<string>;
};

export class ReactionController {
  private base: BaseState = "idle";
  private readonly sessions = new Map<string, SessionState>();
  private readonly terminalEvents = new TerminalEventLedger();
  private dragging: "left" | "right" | null = null;
  private lookDirection: number | null = null;
  private queue: AnimationName[] = [];
  private playingReaction = false;

  constructor(private readonly renderer: PetRenderer) {}

  setAgentEvent(payload: AgentEvent): void {
    const sessionKey = agentSessionKey(payload);
    const eventKey = agentEventKey(payload);
    if (this.terminalEvents.shouldIgnore(payload, eventKey)) return;
    const existing = this.sessions.get(sessionKey);
    const session = existing ?? {
      base: "idle",
      compactResumeBase: null,
      inactivityTimer: null,
      latestEventTimestamp: Number.NEGATIVE_INFINITY,
      latestEventKeys: new Set<string>(),
    };
    if (payload.timestamp < session.latestEventTimestamp || session.latestEventKeys.has(eventKey)) return;
    if (payload.timestamp > session.latestEventTimestamp) session.latestEventKeys.clear();
    session.latestEventTimestamp = Math.max(session.latestEventTimestamp, payload.timestamp);
    session.latestEventKeys.add(eventKey);
    this.sessions.set(sessionKey, session);
    this.terminalEvents.recordActivity(payload);

    let reaction: "start" | "complete" | "failed" | null = null;
    switch (payload.event) {
      case "SessionStart":
        if (payload.sessionSource !== "compact") {
          session.base = "idle";
          session.compactResumeBase = null;
          reaction = "start";
        }
        break;
      case "UserPromptSubmit":
      case "PreToolUse":
      case "PostToolUse":
      case "PostToolUseFailure":
      case "SubagentStart":
      case "SubagentStop":
        session.base = "working";
        break;
      case "PreCompact":
        session.compactResumeBase = session.base === "stalled" ? "working" : session.base;
        session.base = "working";
        break;
      case "PostCompact":
        session.base = payload.compactTrigger === "manual"
          ? "idle"
          : session.compactResumeBase ?? "working";
        session.compactResumeBase = null;
        break;
      case "PermissionRequest":
        session.base = "waiting";
        break;
      case "Stop":
        session.base = "idle";
        session.compactResumeBase = null;
        this.terminalEvents.recordTurn(payload, eventKey);
        reaction = "complete";
        break;
      case "StopFailure":
        session.base = "idle";
        session.compactResumeBase = null;
        this.terminalEvents.recordTurn(payload, eventKey);
        reaction = "failed";
        break;
      case "TurnInterrupted":
        session.base = "idle";
        session.compactResumeBase = null;
        this.terminalEvents.recordTurn(payload, eventKey);
        this.queue = [];
        this.playingReaction = false;
        break;
      case "SessionEnd":
        this.clearSessionTimer(session);
        session.base = "idle";
        session.compactResumeBase = null;
        this.terminalEvents.recordSessionEnd(payload, eventKey);
        this.queue = [];
        this.playingReaction = false;
        break;
      case "HookParseError":
        reaction = "failed";
        break;
    }
    if (session.base === "idle") {
      this.clearSessionTimer(session);
      this.sessions.delete(sessionKey);
    } else {
      this.armInactivityTimeout(sessionKey, session);
    }
    this.base = this.aggregateBase();
    if (this.base === "waiting" || this.base === "working") {
      this.queue = [];
      this.playingReaction = false;
      this.render(true);
    } else if (reaction === "complete") {
      this.replaceQueue(["review", "review", "jumping", "jumping"]);
    } else if (reaction === "start") {
      this.replaceQueue(["waving"]);
    } else if (reaction === "failed") {
      this.replaceQueue(["failed"]);
    } else {
      this.render(true);
    }
  }

  interact(animation: "waving" | "jumping"): void {
    if ((this.base !== "idle" && this.base !== "stalled") || this.dragging) return;
    this.replaceQueue([animation]);
  }

  setDragging(direction: "left" | "right" | null): void {
    if (this.dragging === direction) return;
    this.dragging = direction;
    this.render();
  }

  setLookDirection(direction: number | null): void {
    this.lookDirection = direction;
    if (this.base === "idle" && !this.dragging && !this.playingReaction) this.render();
  }

  refresh(): void { this.render(true); }

  reset(): void {
    this.clearState();
    this.render(true);
  }

  dispose(): void {
    this.clearState();
  }

  private clearState(): void {
    for (const session of this.sessions.values()) this.clearSessionTimer(session);
    this.sessions.clear();
    this.terminalEvents.clear();
    this.base = "idle";
    this.dragging = null;
    this.queue = [];
    this.playingReaction = false;
  }

  private replaceQueue(queue: AnimationName[]): void {
    this.queue = [...queue];
    this.playingReaction = false;
    this.render(true);
  }

  private render(force = false): void {
    if (this.dragging) {
      // Dragging is the visual override. Agent updates may change the state below it,
      // but must never force the current drag animation back to its first frame.
      this.renderer.play(this.dragging === "right" ? "runningRight" : "runningLeft");
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
    if (this.base === "stalled") { this.renderer.play("failed", { loop: true, force }); return; }
    this.playingReaction = false;
    if (this.lookDirection !== null) this.renderer.look(this.lookDirection);
    else this.renderer.play("idle", { force });
  }

  private aggregateBase(): BaseState {
    const bases = [...this.sessions.values()].map(({ base }) => base);
    if (bases.includes("waiting")) return "waiting";
    if (bases.includes("working")) return "working";
    if (bases.includes("stalled")) return "stalled";
    return "idle";
  }

  private clearSessionTimer(session: SessionState): void {
    if (session.inactivityTimer !== null) globalThis.clearTimeout(session.inactivityTimer);
    session.inactivityTimer = null;
  }

  private armInactivityTimeout(sessionId: string, session: SessionState): void {
    if (session.base === "stalled") return;
    this.clearSessionTimer(session);
    if (session.base !== "working") return;
    session.inactivityTimer = globalThis.setTimeout(() => {
      const current = this.sessions.get(sessionId);
      if (current !== session) return;
      session.base = "stalled";
      session.inactivityTimer = globalThis.setTimeout(() => {
        const stalled = this.sessions.get(sessionId);
        if (stalled !== session || session.base !== "stalled") return;
        session.inactivityTimer = null;
        this.sessions.delete(sessionId);
        this.base = this.aggregateBase();
        if (!this.dragging && !this.playingReaction) this.render(true);
      }, STALLED_RETENTION_MS);
      this.base = this.aggregateBase();
      this.queue = [];
      this.playingReaction = false;
      this.render(true);
    }, 120_000);
  }
}
