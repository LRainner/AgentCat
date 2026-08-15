import type { AppConfig } from "../types";
import { codexAdapter } from "./codex";
import { claudeCodeAdapter } from "./claude-code";
import { dshAdapter } from "./dsh";
import type { AgentAdapter, AgentEvent, RawAgentEvent } from "./types";

export class AgentAdapterRegistry {
  private readonly adapters = new Map<string, AgentAdapter>();

  constructor(initialAdapters: Iterable<AgentAdapter> = []) {
    for (const adapter of initialAdapters) this.register(adapter);
  }

  register(adapter: AgentAdapter): void {
    if (this.adapters.has(adapter.id)) throw new Error(`Agent adapter already registered: ${adapter.id}`);
    this.adapters.set(adapter.id, adapter);
  }

  normalize(event: RawAgentEvent): AgentEvent | null {
    return this.adapters.get(event.agent)?.normalize(event) ?? null;
  }

  displayName(agentId: string): string {
    return this.adapters.get(agentId)?.displayName ?? agentId;
  }

  isEnabled(config: AppConfig, agentId: string): boolean {
    return this.adapters.get(agentId)?.isEnabled(config) ?? false;
  }

  showsLiveStatus(config: AppConfig, agentId: string): boolean {
    return this.adapters.get(agentId)?.showsLiveStatus(config) ?? false;
  }

  showsTaskSummary(config: AppConfig, agentId: string): boolean {
    return this.adapters.get(agentId)?.showsTaskSummary(config) ?? false;
  }

  runtimeSignature(config: AppConfig): string {
    return JSON.stringify([...this.adapters.values()].map((adapter) => [
      adapter.id,
      adapter.isEnabled(config),
      adapter.showsLiveStatus(config),
    ]));
  }
}

const registry = new AgentAdapterRegistry([codexAdapter, claudeCodeAdapter, dshAdapter]);

export const registerAgentAdapter = (adapter: AgentAdapter): void => registry.register(adapter);
export const normalizeAgentEvent = (event: RawAgentEvent): AgentEvent | null => registry.normalize(event);
export const agentDisplayName = (agentId: string): string => registry.displayName(agentId);
export const isAgentEnabled = (config: AppConfig, agentId: string): boolean => registry.isEnabled(config, agentId);
export const showsAgentLiveStatus = (config: AppConfig, agentId: string): boolean => registry.showsLiveStatus(config, agentId);
export const showsAgentTaskSummary = (config: AppConfig, agentId: string): boolean => registry.showsTaskSummary(config, agentId);
export const agentRuntimeSignature = (config: AppConfig): string => registry.runtimeSignature(config);
