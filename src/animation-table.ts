export type AnimationName = "idle" | "runningRight" | "runningLeft" | "waving" | "jumping" | "failed" | "waiting" | "running" | "review";

export type AnimationDefinition = {
  row: number;
  frames: number;
  durations: readonly number[];
  loop: boolean;
};

export const ANIMATIONS: Record<AnimationName, AnimationDefinition> = {
  // Codex deliberately holds idle frames for 6x longer than action frames so
  // breathing and blinking remain ambient instead of looking accelerated.
  idle: { row: 0, frames: 6, durations: [1680, 660, 660, 840, 840, 1920], loop: true },
  runningRight: { row: 1, frames: 8, durations: [120, 120, 120, 120, 120, 120, 120, 220], loop: true },
  runningLeft: { row: 2, frames: 8, durations: [120, 120, 120, 120, 120, 120, 120, 220], loop: true },
  waving: { row: 3, frames: 4, durations: [140, 140, 140, 280], loop: false },
  jumping: { row: 4, frames: 5, durations: [140, 140, 140, 140, 280], loop: false },
  failed: { row: 5, frames: 8, durations: [140, 140, 140, 140, 140, 140, 140, 240], loop: false },
  waiting: { row: 6, frames: 6, durations: [150, 150, 150, 150, 150, 260], loop: true },
  running: { row: 7, frames: 6, durations: [120, 120, 120, 120, 120, 220], loop: true },
  review: { row: 8, frames: 6, durations: [150, 150, 150, 150, 150, 280], loop: true },
};

export const LOOK_ANGLES = Array.from({ length: 16 }, (_, index) => index * 22.5);
