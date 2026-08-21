export type PetSource = "agent-cat-builtin" | "codex-builtin" | "codex-custom" | "user-folder";

export type PetDescriptor = {
  key: string;
  id: string;
  displayName: string;
  description?: string;
  version: 1 | 2;
  source: PetSource;
  manifestPath: string;
  spritesheetPath: string;
  width: number;
  height: number;
};

export type CatalogDiagnostic = { path: string; source: PetSource; message: string };
export type CatalogResult = {
  pets: PetDescriptor[];
  diagnostics: CatalogDiagnostic[];
  codexBundles: Array<{ path: string; version?: string }>;
};

export type AppConfig = {
  version: 1;
  language: "system" | "en" | "cn";
  pet: { source: PetSource; id: string; manifestPath: string } | null;
  petSources: { scanCodexBuiltin: boolean; scanCodexCustom: boolean; extraDirectories: string[] };
  window: { x: number | null; y: number | null; scale: number; petOpacity: number; alwaysOnTop: boolean; mousePassthrough: boolean; lockPosition: boolean };
  behavior: { followPointer: boolean; pointerRadius: number; pointerDeadzone: number; clickToWave: boolean; doubleClickToJump: boolean };
  codex: { hooksEnabled: boolean; showLiveStatus: boolean; showTaskSummary: boolean; bubbleScale: number; bubbleOpacity: number };
  claudeCode: { hooksEnabled: boolean; showLiveStatus: boolean; showTaskSummary: boolean };
  dsh: { hooksEnabled: boolean; showLiveStatus: boolean; showTaskSummary: boolean };
};

export type { AgentEvent, RawAgentEvent } from "./agents/types";
export type AgentStatusPhase = "starting" | "thinking" | "tool" | "waiting" | "stalled" | "done" | "interrupted" | "error";
export type AgentLiveStatus = {
  agent: string;
  agentName: string;
  sessionKey: string;
  sessionId: string;
  phase: AgentStatusPhase;
  title: string;
  detail: string;
  timestamp: number;
};
export type PointerSnapshot = { cursorX: number; cursorY: number; windowX: number; windowY: number; windowWidth: number; windowHeight: number };
