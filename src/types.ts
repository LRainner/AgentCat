export type PetSource = "codex-builtin" | "codex-custom" | "user-folder";

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
  pet: { source: PetSource; id: string; manifestPath: string } | null;
  petSources: { scanCodexBuiltin: boolean; scanCodexCustom: boolean; extraDirectories: string[] };
  window: { x: number | null; y: number | null; scale: number; petOpacity: number; alwaysOnTop: boolean; mousePassthrough: boolean; lockPosition: boolean };
  behavior: { followPointer: boolean; pointerRadius: number; pointerDeadzone: number; clickToWave: boolean; doubleClickToJump: boolean };
  codex: { hooksEnabled: boolean; showLiveStatus: boolean; showTaskSummary: boolean; bubbleScale: number; bubbleOpacity: number };
};

export type AgentEvent = {
  version: 1;
  agent: "codex";
  sessionId: string;
  event: string;
  timestamp: number;
  title?: string;
  toolName?: string;
  turnId?: string;
  sessionSource?: string;
  compactTrigger?: string;
};
export type AgentStatusPhase = "starting" | "thinking" | "tool" | "waiting" | "done" | "interrupted" | "error";
export type AgentLiveStatus = {
  sessionId: string;
  phase: AgentStatusPhase;
  title: string;
  detail: string;
  timestamp: number;
};
export type PointerSnapshot = { cursorX: number; cursorY: number; windowX: number; windowY: number; windowWidth: number; windowHeight: number };
