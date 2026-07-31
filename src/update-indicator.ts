export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1_000;
export const UPDATE_CHECK_RETRY_MS = 60 * 60 * 1_000;
export const UPDATE_STATE_EVENT = "agent-cat-update-state-changed";

const UPDATE_STATE_KEY = "agent-cat-update-state";

export type UpdateIndicatorState = {
  version: 1;
  checkedAt: number;
  checkedFromVersion: string;
  availableVersion: string | null;
  seenVersion: string | null;
};

function isState(value: unknown): value is UpdateIndicatorState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<UpdateIndicatorState>;
  return state.version === 1
    && Number.isFinite(state.checkedAt)
    && typeof state.checkedFromVersion === "string"
    && (state.availableVersion === null || typeof state.availableVersion === "string")
    && (state.seenVersion === null || typeof state.seenVersion === "string");
}

export function readUpdateState(storage: Storage, currentVersion: string): UpdateIndicatorState | null {
  try {
    const serialized = storage.getItem(UPDATE_STATE_KEY);
    if (!serialized) return null;
    const state: unknown = JSON.parse(serialized);
    if (!isState(state) || state.checkedFromVersion !== currentVersion) return null;
    return state;
  } catch {
    return null;
  }
}

export function recordUpdateCheck(
  storage: Storage,
  currentVersion: string,
  availableVersion: string | null,
  checkedAt = Date.now(),
): UpdateIndicatorState {
  const previous = readUpdateState(storage, currentVersion);
  const state: UpdateIndicatorState = {
    version: 1,
    checkedAt,
    checkedFromVersion: currentVersion,
    availableVersion,
    seenVersion: previous?.availableVersion === availableVersion ? previous.seenVersion : null,
  };
  try { storage.setItem(UPDATE_STATE_KEY, JSON.stringify(state)); } catch { /* persistence is best effort */ }
  return state;
}

export function hasAvailableUpdate(state: UpdateIndicatorState | null): boolean {
  return Boolean(state?.availableVersion);
}

export function nextUpdateCheckDelay(state: UpdateIndicatorState | null, now = Date.now()): number {
  if (!state) return 0;
  return Math.max(0, UPDATE_CHECK_INTERVAL_MS - (now - state.checkedAt));
}
