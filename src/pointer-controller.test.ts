import { describe, expect, it, vi } from "vitest";
import { calculateLookDirection, PointerController } from "./pointer-controller";
import type { PointerSnapshot } from "./types";

describe("calculateLookDirection", () => {
  it("uses Codex's clockwise orientation", () => {
    expect(calculateLookDirection(0, -100, 500, 36)).toBe(0);
    expect(calculateLookDirection(100, 0, 500, 36)).toBe(4);
    expect(calculateLookDirection(0, 100, 500, 36)).toBe(8);
    expect(calculateLookDirection(-100, 0, 500, 36)).toBe(12);
    expect(calculateLookDirection(100, -100, 500, 36)).toBe(2);
  });

  it("returns idle inside the deadzone or outside the radius", () => {
    expect(calculateLookDirection(10, 10, 500, 36)).toBeNull();
    expect(calculateLookDirection(600, 0, 500, 36)).toBeNull();
  });

  it("does not overlap snapshot requests", async () => {
    vi.useFakeTimers();
    let resolve!: (value: PointerSnapshot) => void;
    const snapshot = vi.fn(() => new Promise<PointerSnapshot>((done) => { resolve = done; }));
    const controller = new PointerController(500, 36, vi.fn(), snapshot);
    controller.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(snapshot).toHaveBeenCalledTimes(1);
    resolve({ cursorX: 100, cursorY: 0, windowX: 0, windowY: 0, windowWidth: 0, windowHeight: 0 });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(120);
    expect(snapshot).toHaveBeenCalledTimes(2);
    controller.stop();
    vi.useRealTimers();
  });

  it("ignores an in-flight snapshot after stop", async () => {
    let resolve!: (value: PointerSnapshot) => void;
    const directions: Array<number | null> = [];
    const snapshot = () => new Promise<PointerSnapshot>((done) => { resolve = done; });
    const controller = new PointerController(500, 36, (direction) => directions.push(direction), snapshot);
    controller.start();
    controller.stop();
    resolve({ cursorX: 100, cursorY: 0, windowX: 0, windowY: 0, windowWidth: 0, windowHeight: 0 });
    await Promise.resolve();
    expect(directions).toEqual([null]);
  });
});
