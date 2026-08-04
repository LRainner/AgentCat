import type { AgentEvent } from "./types";
import { agentSessionKey } from "./agents";

export const MAX_TERMINAL_SESSIONS = 128;
export const MAX_TERMINAL_TURNS = 128;
export const MAX_ACTIVE_TURNS = 128;

type TerminalSession = {
  ended: boolean;
  turnEnded: boolean;
  latestTimestamp: number;
  eventKeys: Set<string>;
};

export function agentEventKey(payload: AgentEvent): string {
  return [
    payload.agent,
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
    const sessionKey = agentSessionKey(payload);
    const terminalSession = this.sessions.get(sessionKey);
    const startsSession = payload.event === "SessionStart" && payload.sessionSource !== "compact";
    const startsTurn = payload.event === "UserPromptSubmit";
    const terminalTurn = payload.turnId
      ? this.turns.has(this.turnKey(sessionKey, payload.turnId))
      : false;
    if (terminalSession?.ended) {
      if (payload.timestamp < terminalSession.latestTimestamp) return true;
      if (startsSession || (startsTurn && !terminalTurn)) return false;
      return true;
    }
    if (terminalSession?.turnEnded && !payload.turnId) {
      if (payload.timestamp < terminalSession.latestTimestamp) return true;
      if (startsSession || payload.event === "UserPromptSubmit" || payload.event === "SessionEnd") return false;
      return true;
    }
    if (payload.event !== "SessionEnd" && terminalTurn) return true;
    const activeTurn = this.activeTurns.get(sessionKey);
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
    const sessionKey = agentSessionKey(payload);
    if (payload.event === "SessionStart" && payload.sessionSource !== "compact") {
      this.sessions.delete(sessionKey);
      this.activeTurns.delete(sessionKey);
      if (payload.turnId) {
        this.turns.delete(this.turnKey(sessionKey, payload.turnId));
        this.rememberActiveTurn(sessionKey, payload.turnId);
      }
      return;
    }
    if (payload.event === "UserPromptSubmit") {
      this.sessions.delete(sessionKey);
      if (payload.turnId) this.rememberActiveTurn(sessionKey, payload.turnId);
      return;
    }
    if (payload.turnId && !this.activeTurns.has(sessionKey)) {
      this.rememberActiveTurn(sessionKey, payload.turnId);
    }
  }

  recordTurn(payload: AgentEvent, eventKey = agentEventKey(payload)): void {
    const sessionKey = agentSessionKey(payload);
    if (payload.turnId) {
      this.remember(this.turns, this.turnKey(sessionKey, payload.turnId), true, MAX_TERMINAL_TURNS);
      if (this.activeTurns.get(sessionKey) === payload.turnId) {
        this.activeTurns.delete(sessionKey);
      }
    }
    this.recordSession(payload, eventKey, false, true);
  }

  recordSessionEnd(payload: AgentEvent, eventKey = agentEventKey(payload)): void {
    const sessionKey = agentSessionKey(payload);
    if (payload.turnId) {
      this.remember(this.turns, this.turnKey(sessionKey, payload.turnId), true, MAX_TERMINAL_TURNS);
    }
    this.activeTurns.delete(sessionKey);
    this.recordSession(payload, eventKey, true, true);
  }

  clear(): void {
    this.sessions.clear();
    this.turns.clear();
    this.activeTurns.clear();
  }

  private recordSession(payload: AgentEvent, eventKey: string, ended: boolean, turnEnded: boolean): void {
    const sessionKey = agentSessionKey(payload);
    const existing = this.sessions.get(sessionKey);
    const eventKeys = payload.timestamp === existing?.latestTimestamp
      ? existing.eventKeys
      : new Set<string>();
    eventKeys.add(eventKey);
    const terminal = {
      ended: ended || existing?.ended === true,
      turnEnded: turnEnded || existing?.turnEnded === true,
      latestTimestamp: Math.max(payload.timestamp, existing?.latestTimestamp ?? Number.NEGATIVE_INFINITY),
      eventKeys,
    };
    this.remember(this.sessions, sessionKey, terminal, MAX_TERMINAL_SESSIONS);
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

  private turnKey(sessionKey: string, turnId: string): string {
    return `${sessionKey}\u0000${turnId}`;
  }

  private rememberActiveTurn(sessionId: string, turnId: string): void {
    this.remember(this.activeTurns, sessionId, turnId, MAX_ACTIVE_TURNS);
  }
}
