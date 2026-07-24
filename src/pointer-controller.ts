import { invoke } from "@tauri-apps/api/core";
import type { PointerSnapshot } from "./types";

export function calculateLookDirection(dx: number, dy: number, radius: number, deadzone: number): number | null {
  const distance = Math.hypot(dx, dy);
  if (distance <= deadzone || distance > radius) return null;
  const degrees = (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360;
  return Math.round(degrees / 22.5) % 16;
}

export class PointerController {
  private timer: number | null = null;
  private running = false;
  private generation = 0;

  constructor(
    private readonly radius: number,
    private readonly deadzone: number,
    private readonly onDirection: (direction: number | null) => void,
    private readonly snapshot: () => Promise<PointerSnapshot> = () => invoke<PointerSnapshot>("pointer_snapshot"),
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    const generation = ++this.generation;
    const tick = async () => {
      try {
        const point = await this.snapshot();
        if (!this.running || generation !== this.generation) return;
        const dx = point.cursorX - (point.windowX + point.windowWidth / 2);
        const dy = point.cursorY - (point.windowY + point.windowHeight / 2);
        this.onDirection(calculateLookDirection(dx, dy, this.radius, this.deadzone));
      } catch {
        if (!this.running || generation !== this.generation) return;
        this.onDirection(null);
      } finally {
        if (this.running && generation === this.generation) {
          this.timer = globalThis.setTimeout(() => void tick(), 120);
        }
      }
    };
    void tick();
  }

  stop(): void {
    this.running = false;
    this.generation += 1;
    if (this.timer !== null) globalThis.clearTimeout(this.timer);
    this.timer = null;
    this.onDirection(null);
  }
}
