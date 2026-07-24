import { ANIMATIONS, type AnimationName } from "./animation-table";
import type { PetDescriptor } from "./types";

const CELL_WIDTH = 192;
const CELL_HEIGHT = 208;

export type FrameInfo = { mode: AnimationName | "look"; row: number; column: number; frame: number; angle?: number };

export class PetRenderer {
  private pet: PetDescriptor | null = null;
  private scale = 1;
  private timer: number | null = null;
  private playbackKey = "";
  private reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  onFrame?: (frame: FrameInfo) => void;

  constructor(private readonly element: HTMLElement) {}

  async setPet(pet: PetDescriptor, imageUrl: string, scale: number): Promise<void> {
    this.stop();
    this.pet = pet;
    this.scale = scale;
    this.element.style.backgroundImage = `url("${imageUrl}")`;
    this.element.dataset.version = String(pet.version);
    this.resize(scale);
    this.play("idle", { force: true });
  }

  resize(scale: number): void {
    this.scale = scale;
    const rows = this.pet?.version === 2 ? 11 : 9;
    this.element.style.width = `${CELL_WIDTH * scale}px`;
    this.element.style.height = `${CELL_HEIGHT * scale}px`;
    this.element.style.backgroundSize = `${CELL_WIDTH * 8 * scale}px ${CELL_HEIGHT * rows * scale}px`;
  }

  play(name: AnimationName, options: { loop?: boolean; force?: boolean; onComplete?: () => void } = {}): void {
    const definition = ANIMATIONS[name];
    const loop = options.loop ?? definition.loop;
    const key = `animation:${name}:${loop}`;
    if (!options.force && this.playbackKey === key) return;
    this.stop();
    this.playbackKey = key;
    let frame = 0;
    const draw = () => {
      if (this.playbackKey !== key) return;
      this.draw(definition.row, frame);
      this.onFrame?.({ mode: name, row: definition.row, column: frame, frame });
      if (this.reducedMotion.matches) {
        if (!loop) this.timer = window.setTimeout(() => { this.playbackKey = ""; options.onComplete?.(); }, 450);
        return;
      }
      this.timer = window.setTimeout(() => {
        frame += 1;
        if (frame >= definition.frames) {
          if (!loop) {
            this.playbackKey = "";
            this.timer = null;
            options.onComplete?.();
            return;
          }
          frame = 0;
        }
        draw();
      }, definition.durations[frame]);
    };
    draw();
  }

  look(direction: number): void {
    if (this.pet?.version !== 2) {
      this.play("idle");
      return;
    }
    const normalized = ((direction % 16) + 16) % 16;
    const key = `look:${normalized}`;
    if (this.playbackKey === key) return;
    this.stop();
    this.playbackKey = key;
    const row = normalized < 8 ? 9 : 10;
    const column = normalized % 8;
    this.draw(row, column);
    this.onFrame?.({ mode: "look", row, column, frame: column, angle: normalized * 22.5 });
  }

  stop(): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
    this.playbackKey = "";
  }

  private draw(row: number, column: number): void {
    this.element.style.backgroundPosition = `${-column * CELL_WIDTH * this.scale}px ${-row * CELL_HEIGHT * this.scale}px`;
  }
}

