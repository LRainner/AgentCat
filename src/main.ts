import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { PetRenderer } from "./pet-renderer";
import { PetDragController, type DragCompletionMode, type DragEndedEvent } from "./pet-drag-controller";
import { PointerController } from "./pointer-controller";
import { ReactionController } from "./reaction-controller";
import type { AppConfig, CatalogResult, PetDescriptor } from "./types";
import {
  AGENT_EVENT_CHANNEL,
  agentRuntimeSignature,
  isAgentEnabled,
  normalizeAgentEvent,
  type RawAgentEvent,
} from "./agents";
import {
  nextUpdateCheckDelay,
  readUpdateState,
  recordUpdateCheck,
  UPDATE_CHECK_RETRY_MS,
  UPDATE_STATE_EVENT,
} from "./update-indicator";

const stage = document.querySelector<HTMLElement>("#pet-stage")!;
const sprite = document.querySelector<HTMLElement>("#pet-sprite")!;
const fallback = document.querySelector<HTMLElement>("#fallback-cat")!;
const errorBox = document.querySelector<HTMLElement>("#pet-error")!;
const renderer = new PetRenderer(sprite);
const reactions = new ReactionController(renderer);
const dragController = new PetDragController({
  startDrag: (dragId) => invoke<DragCompletionMode>("start_dragging", { dragId }),
  setDragging: (direction) => reactions.setDragging(direction),
  savePosition: async () => { config = await invoke<AppConfig>("save_main_position"); },
});
let config: AppConfig;
let pointer: PointerController | null = null;
let activePet: PetDescriptor | null = null;
let clickTimer: number | null = null;
let petLoadRequest = 0;
let updateCheckTimer: number | null = null;

const INITIAL_UPDATE_CHECK_DELAY_MS = 15_000;

function scheduleUpdateCheck(delay: number): void {
  if (updateCheckTimer !== null) window.clearTimeout(updateCheckTimer);
  updateCheckTimer = window.setTimeout(() => void checkForUpdatesInBackground(), delay);
}

async function checkForUpdatesInBackground(): Promise<void> {
  updateCheckTimer = null;
  let update: Update | null = null;
  try {
    const currentVersion = await getVersion();
    const state = readUpdateState(localStorage, currentVersion);
    const wait = nextUpdateCheckDelay(state);
    if (wait > 0) {
      scheduleUpdateCheck(wait);
      return;
    }

    update = await check();
    const next = recordUpdateCheck(localStorage, currentVersion, update?.version ?? null);
    await emit(UPDATE_STATE_EVENT, next);
    scheduleUpdateCheck(nextUpdateCheckDelay(next));
  } catch {
    scheduleUpdateCheck(UPDATE_CHECK_RETRY_MS);
  } finally {
    await update?.close().catch(() => undefined);
  }
}

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
  if (previous && agentRuntimeSignature(previous) !== agentRuntimeSignature(config)) reactions.reset();
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
  dragController.pointerDown({ x: event.screenX, y: event.screenY });
});

stage.addEventListener("pointermove", (event) => {
  dragController.pointerMove({ x: event.screenX, y: event.screenY });
});

window.addEventListener("pointerup", () => dragController.pointerReleased());
window.addEventListener("blur", () => dragController.pointerReleased());
void listen<DragEndedEvent>("agent-cat-drag-ended", ({ payload }) => dragController.nativeEnded(payload));

stage.addEventListener("click", () => {
  if (dragController.shouldSuppressClick() || !config.behavior.clickToWave) return;
  if (clickTimer !== null) window.clearTimeout(clickTimer);
  clickTimer = window.setTimeout(() => {
    reactions.interact("waving");
    clickTimer = null;
  }, 230);
});

stage.addEventListener("dblclick", () => {
  if (dragController.shouldSuppressClick() || !config.behavior.doubleClickToJump) return;
  if (clickTimer !== null) window.clearTimeout(clickTimer);
  clickTimer = null;
  reactions.interact("jumping");
});

void getCurrentWindow().onMoved(({ payload }) => {
  dragController.windowMoved(payload.x);
  void invoke("sync_status_window", { contentHeight: null });
});

void listen<RawAgentEvent>(AGENT_EVENT_CHANNEL, ({ payload }) => {
  const event = normalizeAgentEvent(payload);
  if (event && config && isAgentEnabled(config, event.agent)) reactions.setAgentEvent(event);
});
void listen("agent-cat-pet-state-reset", () => {
  dragController.reset();
  reactions.reset();
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
window.addEventListener("beforeunload", () => {
  reactions.dispose();
  if (updateCheckTimer !== null) window.clearTimeout(updateCheckTimer);
});
scheduleUpdateCheck(INITIAL_UPDATE_CHECK_DELAY_MS);
void load();
