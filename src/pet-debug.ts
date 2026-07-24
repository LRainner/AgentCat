import { invoke } from "@tauri-apps/api/core";
import { ANIMATIONS, LOOK_ANGLES, type AnimationName } from "./animation-table";
import { PetRenderer } from "./pet-renderer";
import type { CatalogResult, PetDescriptor } from "./types";

const select = document.querySelector<HTMLSelectElement>("#debug-pet")!;
const sprite = document.querySelector<HTMLElement>("#debug-sprite")!;
const stage = document.querySelector<HTMLElement>("#debug-stage")!;
const info = document.querySelector<HTMLElement>("#debug-info")!;
const validation = document.querySelector<HTMLElement>("#debug-validation")!;
const renderer = new PetRenderer(sprite);
let pets: PetDescriptor[] = [];
let active: PetDescriptor;
type SpriteInspection = { unusedCells: number; nonTransparentPixels: number; transparent: boolean };

renderer.onFrame = (frame) => { info.textContent = `模式: ${frame.mode}\n行: ${frame.row}\n列: ${frame.column}\n帧: ${frame.frame}${frame.angle === undefined ? "" : `\n角度: ${String(frame.angle).padStart(3, "0")}°`}`; };

async function initialize(): Promise<void> {
  const catalog = await invoke<CatalogResult>("scan_pets");
  pets = catalog.pets;
  select.replaceChildren(...pets.map((pet, index) => {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = `${pet.displayName} · v${pet.version}`;
    return option;
  }));
  if (!pets.length) { validation.textContent = "没有可测试的宠物"; return; }
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
  validation.innerHTML = `<strong>${escapeHtml(active.displayName)}</strong> · ${escapeHtml(active.source)}<br><strong class="status-ok">尺寸正确</strong><br>${active.width}×${active.height} · 8×${active.version === 2 ? 11 : 9} · cell 192×208<br><strong class="${inspection.transparent ? "status-ok" : "status-error"}">${inspection.transparent ? "未使用格完全透明" : `未使用格含 ${inspection.nonTransparentPixels} 个非透明像素`}</strong> · ${inspection.unusedCells} 格<br><code>${escapeHtml(active.spritesheetPath)}</code>`;
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
