import type { AgentEvent } from "./types";

export const MAX_TERMINAL_SESSIONS = 128;
export const MAX_TERMINAL_TURNS = 128;
export const MAX_ACTIVE_TURNS = 128;

type TerminalSession = {
  ended: boolean;
  latestTimestamp: number;
  eventKeys: Set<string>;
};

export function agentEventKey(payload: AgentEvent): string {
  return [
    payload.sessionId,
    payload.turnId ?? "",
    payload.event,
    payload.timestamp,
    payload.title ?? "",
    payload.toolName ?? "",
    payload.sessionSource ?? "",
    payload.compactTrigger ?? "",
  ].join(":");
}

export class TerminalEventLedger {
  private readonly sessions = new Map<string, TerminalSession>();
  private readonly turns = new Map<string, true>();
  private readonly activeTurns = new Map<string, string>();

  shouldIgnore(payload: AgentEvent, eventKey = agentEventKey(payload)): boolean {
    const terminalSession = this.sessions.get(payload.sessionId);
    const startsSession = payload.event === "SessionStart" && payload.sessionSource !== "compact";
    const startsTurn = payload.event === "UserPromptSubmit" && payload.turnId !== undefined;
    const terminalTurn = payload.turnId
      ? this.turns.has(this.turnKey(payload.sessionId, payload.turnId))
      : false;
    if (terminalSession?.ended) {
      if (payload.timestamp < terminalSession.latestTimestamp) return true;
      if (startsSession || (startsTurn && !terminalTurn)) return false;
      return true;
    }
    if (payload.event !== "SessionEnd" && terminalTurn) return true;
    const activeTurn = this.activeTurns.get(payload.sessionId);
    if (
      payload.turnId
      && activeTurn
      && payload.turnId !== activeTurn
      && !startsSession
      && !startsTurn
    ) return true;
    return terminalSession !== undefined && (
      payload.timestamp < terminalSession.latestTimestamp
      || terminalSession.eventKeys.has(eventKey)
    );
  }

  recordActivity(payload: AgentEvent): void {
    if (payload.event === "SessionStart" && payload.sessionSource !== "compact") {
      this.sessions.delete(payload.sessionId);
      this.activeTurns.delete(payload.sessionId);
      if (payload.turnId) {
        this.turns.delete(this.turnKey(payload.sessionId, payload.turnId));
        this.rememberActiveTurn(payload.sessionId, payload.turnId);
      }
      return;
    }
    if (payload.event === "UserPromptSubmit") {
      this.sessions.delete(payload.sessionId);
      if (payload.turnId) this.rememberActiveTurn(payload.sessionId, payload.turnId);
      return;
    }
    if (payload.turnId && !this.activeTurns.has(payload.sessionId)) {
      this.rememberActiveTurn(payload.sessionId, payload.turnId);
    }
  }

  recordTurn(payload: AgentEvent, eventKey = agentEventKey(payload)): void {
    if (payload.turnId) {
      this.remember(this.turns, this.turnKey(payload.sessionId, payload.turnId), true, MAX_TERMINAL_TURNS);
      if (this.activeTurns.get(payload.sessionId) === payload.turnId) {
        this.activeTurns.delete(payload.sessionId);
      }
    }
    this.recordSession(payload, eventKey, false);
  }

  recordSessionEnd(payload: AgentEvent, eventKey = agentEventKey(payload)): void {
    if (payload.turnId) {
      this.remember(this.turns, this.turnKey(payload.sessionId, payload.turnId), true, MAX_TERMINAL_TURNS);
    }
    this.activeTurns.delete(payload.sessionId);
    this.recordSession(payload, eventKey, true);
  }

  clear(): void {
    this.sessions.clear();
    this.turns.clear();
    this.activeTurns.clear();
  }

  private recordSession(payload: AgentEvent, eventKey: string, ended: boolean): void {
    const existing = this.sessions.get(payload.sessionId);
    const eventKeys = payload.timestamp === existing?.latestTimestamp
      ? existing.eventKeys
      : new Set<string>();
    eventKeys.add(eventKey);
    const terminal = {
      ended: ended || existing?.ended === true,
      latestTimestamp: Math.max(payload.timestamp, existing?.latestTimestamp ?? Number.NEGATIVE_INFINITY),
      eventKeys,
    };
    this.remember(this.sessions, payload.sessionId, terminal, MAX_TERMINAL_SESSIONS);
  }

  private remember<T>(map: Map<string, T>, key: string, value: T, limit: number): void {
    map.delete(key);
    map.set(key, value);
    while (map.size > limit) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }

  private turnKey(sessionId: string, turnId: string): string {
    return `${sessionId}\u0000${turnId}`;
  }

  private rememberActiveTurn(sessionId: string, turnId: string): void {
    this.remember(this.activeTurns, sessionId, turnId, MAX_ACTIVE_TURNS);
  }
}
