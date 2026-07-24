import { describe, expect, it } from "vitest";
import { ANIMATIONS } from "./animation-table";

describe("animation timing", () => {
  it("keeps the ambient idle cycle at Codex's six-times action cadence", () => {
    expect(ANIMATIONS.idle.durations).toEqual([1680, 660, 660, 840, 840, 1920]);
    expect(ANIMATIONS.idle.durations.reduce((total, duration) => total + duration, 0)).toBe(6600);
  });

  it("provides one duration for every animation frame", () => {
    for (const definition of Object.values(ANIMATIONS)) {
      expect(definition.durations).toHaveLength(definition.frames);
      expect(definition.durations.every((duration) => duration > 0)).toBe(true);
    }
  });
});
