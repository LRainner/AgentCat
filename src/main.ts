import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { PetRenderer } from "./pet-renderer";
import { PointerController } from "./pointer-controller";
import { ReactionController } from "./reaction-controller";
import type { AgentEvent, AppConfig, CatalogResult, PetDescriptor } from "./types";

const stage = document.querySelector<HTMLElement>("#pet-stage")!;
const sprite = document.querySelector<HTMLElement>("#pet-sprite")!;
const fallback = document.querySelector<HTMLElement>("#fallback-cat")!;
const errorBox = document.querySelector<HTMLElement>("#pet-error")!;
const renderer = new PetRenderer(sprite);
const reactions = new ReactionController(renderer);
let config: AppConfig;
let pointer: PointerController | null = null;
let activePet: PetDescriptor | null = null;
let dragged = false;
let pointerDown: { x: number; y: number } | null = null;
let lastWindowX: number | null = null;
let clickTimer: number | null = null;
let petLoadRequest = 0;

function resolvePet(catalog: CatalogResult, value: AppConfig): PetDescriptor | null {
  if (value.pet) {
    return catalog.pets.find((pet) => pet.manifestPath === value.pet?.manifestPath)
      ?? catalog.pets.find((pet) => pet.source === value.pet?.source && pet.id === value.pet?.id)
      ?? catalog.pets[0]
      ?? null;
  }
  return catalog.pets[0] ?? null;
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function refreshActivePet(): Promise<void> {
  const request = ++petLoadRequest;
  const catalog = await invoke<CatalogResult>("scan_pets");
  if (request !== petLoadRequest) return;
  const nextPet = resolvePet(catalog, config);
  if (!nextPet) {
    activePet = null;
    renderer.stop();
    sprite.hidden = true;
    fallback.hidden = false;
    errorBox.textContent = "";
    stopPointer();
    return;
  }
  if (activePet?.spritesheetPath === nextPet.spritesheetPath && !sprite.hidden) {
    activePet = nextPet;
    renderer.resize(config.window.scale);
    configurePointer();
    return;
  }
  const image = await invoke<string>("load_sprite_data_url", { path: nextPet.spritesheetPath });
  if (request !== petLoadRequest) return;
  activePet = nextPet;
  fallback.hidden = true;
  sprite.hidden = false;
  await renderer.setPet(nextPet, image, config.window.scale);
  reactions.refresh();
  configurePointer();
  errorBox.textContent = config.pet && config.pet.manifestPath !== nextPet.manifestPath
    ? "上次选择的宠物不可用，已临时回退"
    : "";
}

async function applyConfig(next: AppConfig, forcePetRefresh = false): Promise<void> {
  const previous = config;
  config = next;
  stage.style.setProperty("--pet-opacity", String(Math.min(1, Math.max(0.2, config.window.petOpacity))));
  const petChanged = forcePetRefresh
    || !previous
    || !sameValue(previous.pet, config.pet)
    || !sameValue(previous.petSources, config.petSources);
  if (petChanged) {
    await refreshActivePet();
    return;
  }
  if (activePet) renderer.resize(config.window.scale);
  if (!previous || !sameValue(previous.behavior, config.behavior)) configurePointer();
}

async function load(): Promise<void> {
  try {
    await applyConfig(await invoke<AppConfig>("get_config"), true);
  } catch (error) {
    activePet = null;
    renderer.stop();
    sprite.hidden = true;
    fallback.hidden = false;
    errorBox.textContent = String(error);
  }
}

function configurePointer(): void {
  stopPointer();
  if (!config.behavior.followPointer || activePet?.version !== 2) return;
  pointer = new PointerController(config.behavior.pointerRadius, config.behavior.pointerDeadzone, (direction) => reactions.setLookDirection(direction));
  pointer.start();
}

function stopPointer(): void {
  pointer?.stop();
  pointer = null;
}

stage.addEventListener("contextmenu", (event) => {
  event.preventDefault();
  void invoke("show_window", { kind: "settings" });
});

stage.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || config?.window.lockPosition) return;
  pointerDown = { x: event.screenX, y: event.screenY };
  dragged = false;
});

stage.addEventListener("pointermove", (event) => {
  if (!pointerDown || dragged) return;
  const dx = event.screenX - pointerDown.x;
  const dy = event.screenY - pointerDown.y;
  if (Math.hypot(dx, dy) < 5) return;
  dragged = true;
  reactions.setDragging(dx >= 0 ? "right" : "left");
  void invoke("start_dragging");
});

async function finishDrag(): Promise<void> {
  pointerDown = null;
  if (!dragged) return;
  window.setTimeout(() => reactions.setDragging(null), 80);
  try { config = await invoke<AppConfig>("save_main_position"); } catch { /* position persistence is best effort */ }
  window.setTimeout(() => { dragged = false; }, 120);
}

window.addEventListener("pointerup", () => void finishDrag());
window.addEventListener("blur", () => void finishDrag());

stage.addEventListener("click", () => {
  if (dragged || !config.behavior.clickToWave) return;
  if (clickTimer !== null) window.clearTimeout(clickTimer);
  clickTimer = window.setTimeout(() => {
    reactions.interact("waving");
    clickTimer = null;
  }, 230);
});

stage.addEventListener("dblclick", () => {
  if (dragged || !config.behavior.doubleClickToJump) return;
  if (clickTimer !== null) window.clearTimeout(clickTimer);
  clickTimer = null;
  reactions.interact("jumping");
});

void getCurrentWindow().onMoved(({ payload }) => {
  if (lastWindowX !== null && dragged) reactions.setDragging(payload.x >= lastWindowX ? "right" : "left");
  lastWindowX = payload.x;
  void invoke("sync_status_window");
});

void listen<AgentEvent>("codex-event", ({ payload }) => {
  if (config?.codex.hooksEnabled) reactions.setAgentEvent(payload);
});

void listen<AppConfig>("agent-cat-config-preview", ({ payload }) => {
  void applyConfig(payload).catch((error) => { errorBox.textContent = String(error); });
});
void listen("agent-cat-config-changed", async () => {
  try {
    await applyConfig(await invoke<AppConfig>("get_config"));
  } catch (error) {
    errorBox.textContent = String(error);
  }
});
window.addEventListener("beforeunload", () => reactions.dispose());
void load();
