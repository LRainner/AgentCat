export type DragDirection = "left" | "right";
export type DragCompletionMode = "native" | "webview";
export type DragEndedEvent = { dragId: number };

type Point = { x: number; y: number };
type DragState =
  | { kind: "idle" }
  | { kind: "pressed"; origin: Point }
  | {
      kind: "active";
      id: number;
      direction: DragDirection;
      completion: DragCompletionMode | null;
      releaseRequested: boolean;
    };

type DragEffects = {
  startDrag: (dragId: number) => Promise<DragCompletionMode>;
  setDragging: (direction: DragDirection | null) => void;
  savePosition: () => Promise<void>;
  now?: () => number;
};

const START_THRESHOLD_PX = 5;
const DIRECTION_THRESHOLD_PX = 2;
const CLICK_SUPPRESSION_MS = 180;

export class PetDragController {
  private state: DragState = { kind: "idle" };
  private nextId = 1;
  private lastWindowX: number | null = null;
  private suppressClickUntil = 0;
  private readonly now: () => number;

  constructor(private readonly effects: DragEffects) {
    this.now = effects.now ?? (() => performance.now());
  }

  pointerDown(point: Point): void {
    if (this.state.kind !== "idle") return;
    this.state = { kind: "pressed", origin: point };
  }

  pointerMove(point: Point): void {
    if (this.state.kind !== "pressed") return;
    const dx = point.x - this.state.origin.x;
    const dy = point.y - this.state.origin.y;
    if (Math.hypot(dx, dy) < START_THRESHOLD_PX) return;

    const id = this.nextId++;
    const direction: DragDirection = dx < 0 ? "left" : "right";
    this.state = { kind: "active", id, direction, completion: null, releaseRequested: false };
    this.lastWindowX = null;
    this.effects.setDragging(direction);
    void this.effects.startDrag(id).then(
      (completion) => this.dragStarted(id, completion),
      () => this.finish(id),
    );
  }

  pointerReleased(): void {
    if (this.state.kind === "pressed") {
      this.state = { kind: "idle" };
      return;
    }
    if (this.state.kind !== "active") return;
    this.state.releaseRequested = true;
    if (this.state.completion === "webview") this.finish(this.state.id);
  }

  windowMoved(x: number): void {
    if (this.state.kind !== "active") {
      this.lastWindowX = null;
      return;
    }
    if (this.lastWindowX === null) {
      this.lastWindowX = x;
      return;
    }
    const delta = x - this.lastWindowX;
    if (Math.abs(delta) < DIRECTION_THRESHOLD_PX) return;
    this.lastWindowX = x;
    const direction: DragDirection = delta < 0 ? "left" : "right";
    if (direction === this.state.direction) return;
    this.state.direction = direction;
    this.effects.setDragging(direction);
  }

  nativeEnded(event: DragEndedEvent): void {
    this.finish(event.dragId);
  }

  shouldSuppressClick(): boolean {
    return this.state.kind === "active" || this.now() < this.suppressClickUntil;
  }

  reset(): void {
    if (this.state.kind === "active") this.effects.setDragging(null);
    this.state = { kind: "idle" };
    this.lastWindowX = null;
  }

  stateKind(): DragState["kind"] {
    return this.state.kind;
  }

  private dragStarted(id: number, completion: DragCompletionMode): void {
    if (this.state.kind !== "active" || this.state.id !== id) return;
    this.state.completion = completion;
    if (completion === "webview" && this.state.releaseRequested) this.finish(id);
  }

  private finish(id: number): void {
    if (this.state.kind !== "active" || this.state.id !== id) return;
    this.effects.setDragging(null);
    this.state = { kind: "idle" };
    this.lastWindowX = null;
    this.suppressClickUntil = this.now() + CLICK_SUPPRESSION_MS;
    void this.effects.savePosition().catch(() => undefined);
  }
}
