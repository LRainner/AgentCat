import { describe, expect, it } from "vitest";
import {
  hasUnseenUpdate,
  markUpdateSeen,
  nextUpdateCheckDelay,
  readUpdateState,
  recordUpdateCheck,
  UPDATE_CHECK_INTERVAL_MS,
} from "./update-indicator";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

describe("update indicator state", () => {
  it("shows a newly discovered version until it is seen", () => {
    const storage = new MemoryStorage();
    const discovered = recordUpdateCheck(storage, "1.4.0", "1.5.0", 1_000);
    expect(hasUnseenUpdate(discovered)).toBe(true);

    const seen = markUpdateSeen(storage, discovered);
    expect(hasUnseenUpdate(seen)).toBe(false);
    expect(readUpdateState(storage, "1.4.0")).toEqual(seen);
  });

  it("shows the indicator again when a different version is discovered", () => {
    const storage = new MemoryStorage();
    const first = markUpdateSeen(storage, recordUpdateCheck(storage, "1.4.0", "1.5.0", 1_000));
    const second = recordUpdateCheck(storage, "1.4.0", "1.6.0", 2_000);
    expect(first.seenVersion).toBe("1.5.0");
    expect(second.seenVersion).toBeNull();
    expect(hasUnseenUpdate(second)).toBe(true);
  });

  it("invalidates saved state after the app version changes", () => {
    const storage = new MemoryStorage();
    recordUpdateCheck(storage, "1.4.0", "1.5.0", 1_000);
    expect(readUpdateState(storage, "1.5.0")).toBeNull();
    expect(nextUpdateCheckDelay(null, 2_000)).toBe(0);
  });

  it("checks at most once per interval after a successful check", () => {
    const storage = new MemoryStorage();
    const state = recordUpdateCheck(storage, "1.4.0", null, 1_000);
    expect(nextUpdateCheckDelay(state, 2_000)).toBe(UPDATE_CHECK_INTERVAL_MS - 1_000);
    expect(nextUpdateCheckDelay(state, 1_000 + UPDATE_CHECK_INTERVAL_MS)).toBe(0);
  });
});
