import { invoke } from "@tauri-apps/api/core";
import { ANIMATIONS, LOOK_ANGLES, type AnimationName } from "./animation-table";
import { PetRenderer } from "./pet-renderer";
import type { AppConfig, CatalogResult, PetDescriptor } from "./types";
import { nativeMessages, setLanguage, t, translateDocument } from "./i18n";

const select = document.querySelector<HTMLSelectElement>("#debug-pet")!;
const sprite = document.querySelector<HTMLElement>("#debug-sprite")!;
const stage = document.querySelector<HTMLElement>("#debug-stage")!;
const info = document.querySelector<HTMLElement>("#debug-info")!;
const validation = document.querySelector<HTMLElement>("#debug-validation")!;
const renderer = new PetRenderer(sprite);
let pets: PetDescriptor[] = [];
let active: PetDescriptor;
type SpriteInspection = { unusedCells: number; nonTransparentPixels: number; transparent: boolean };

renderer.onFrame = (frame) => {
  const frameInfo = t("Mode: {mode}\nRow: {row}\nColumn: {column}\nFrame: {frame}", frame);
  info.textContent = frame.angle === undefined ? frameInfo : `${frameInfo}\n${t("Angle: {angle}°", { angle: String(frame.angle).padStart(3, "0") })}`;
};

async function initialize(): Promise<void> {
  const [catalog, config] = await Promise.all([invoke<CatalogResult>("scan_pets"), invoke<AppConfig>("get_config")]);
  setLanguage(config.language);
  translateDocument();
  void invoke("sync_native_i18n", { value: nativeMessages() });
  pets = catalog.pets;
  select.replaceChildren(...pets.map((pet, index) => {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = `${pet.displayName} · v${pet.version}`;
    return option;
  }));
  if (!pets.length) { validation.textContent = t("No pets are available for testing"); return; }
  const initialIndex = Math.max(0, pets.findIndex((pet) => pet.source === "codex-builtin"));
  select.value = String(initialIndex);
  await loadPet(initialIndex);
  buildButtons();
}

async function loadPet(index: number): Promise<void> {
  active = pets[index];
  select.value = String(index);
  const image = await invoke<string>("load_sprite_data_url", { path: active.spritesheetPath });
  const scale = Number((document.querySelector<HTMLInputElement>("#debug-scale")!).value);
  await renderer.setPet(active, image, scale);
  const inspection = await invoke<SpriteInspection>("inspect_sprite", { path: active.spritesheetPath, version: active.version });
  validation.innerHTML = `<strong>${escapeHtml(active.displayName)}</strong> · ${escapeHtml(active.source)}<br><strong class="status-ok">${t("Dimensions are correct")}</strong><br>${active.width}×${active.height} · 8×${active.version === 2 ? 11 : 9} · cell 192×208<br><strong class="${inspection.transparent ? "status-ok" : "status-error"}">${inspection.transparent ? t("Unused cells are fully transparent") : t("Unused cells contain {count} non-transparent pixels", { count: inspection.nonTransparentPixels })}</strong> · ${t("{count} cells", { count: inspection.unusedCells })}<br><code>${escapeHtml(active.spritesheetPath)}</code>`;
  document.querySelector<HTMLElement>("#look-buttons")!.classList.toggle("disabled", active.version !== 2);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>\"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]!);
}

function buildButtons(): void {
  const animations = document.querySelector<HTMLElement>("#animation-buttons")!;
  for (const name of Object.keys(ANIMATIONS) as AnimationName[]) {
    const button = document.createElement("button");
    button.textContent = name;
    button.addEventListener("click", () => renderer.play(name, { force: true }));
    animations.append(button);
  }
  const looks = document.querySelector<HTMLElement>("#look-buttons")!;
  LOOK_ANGLES.forEach((angle, direction) => {
    const button = document.createElement("button");
    button.textContent = `${angle.toFixed(angle % 1 ? 1 : 0).padStart(5, "0")}°`;
    button.addEventListener("click", () => renderer.look(direction));
    looks.append(button);
  });
}

select.addEventListener("change", () => void loadPet(Number(select.value)));
document.querySelector("#debug-scale")!.addEventListener("input", (event) => renderer.resize(Number((event.target as HTMLInputElement).value)));
document.querySelector("#debug-background")!.addEventListener("input", (event) => stage.style.background = (event.target as HTMLInputElement).value);
void initialize().catch((error) => validation.textContent = String(error));
