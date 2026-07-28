import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { emit, listen } from "@tauri-apps/api/event";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import type { AppConfig, CatalogResult, PetDescriptor, PetSource } from "./types";
import { advanceUpdateProgress, emptyUpdateProgress, formatBytes, updateProgressPercent } from "./update-progress";

type HookStatus = { path: string; exists: boolean; valid: boolean; installedEvents: number; expectedEvents: number; message: string };
type HookRuntimeStatus = { receiverRunning: boolean; socketPath: string; lastEventAt: number | null; lastEvent: string | null; lastEventIsTest: boolean };
type SettingsPage = "general" | "codex" | "about";

const settingsPageCopy: Record<SettingsPage, { eyebrow: string; title: string; description: string }> = {
  general: { eyebrow: "PREFERENCES", title: "通用", description: "选择宠物并调整它在桌面上的表现。" },
  codex: { eyebrow: "INTEGRATIONS", title: "Codex", description: "管理 Hook 连接、实时状态和任务摘要。" },
  about: { eyebrow: "ABOUT", title: "关于", description: "查看 Agent Cat 版本和软件更新。" },
};

const sourceLabels: Record<PetSource, string> = { "codex-builtin": "Codex 内置", "codex-custom": "Codex 自定义宠物", "user-folder": "其他目录" };
const eventLabels: Record<string, string> = {
  SessionStart: "会话开始",
  UserPromptSubmit: "收到任务",
  PreToolUse: "开始使用工具",
  PostToolUse: "工具执行完成",
  SubagentStart: "协作开始",
  SubagentStop: "协作完成",
  PreCompact: "整理上下文",
  PostCompact: "继续任务",
  PermissionRequest: "等待确认",
  Stop: "任务完成",
  SessionEnd: "会话退出",
  TurnInterrupted: "任务中断",
  HookParseError: "解析失败",
};
const message = document.querySelector<HTMLElement>("#settings-message")!;
const catalogElement = document.querySelector<HTMLElement>("#pet-catalog")!;
const summary = document.querySelector<HTMLElement>("#catalog-summary")!;
const appIconUrl = new URL("../assets/app-icon.svg", import.meta.url).href;
for (const image of document.querySelectorAll<HTMLImageElement>(".settings-brand-mark, .about-logo")) image.src = appIconUrl;
let config: AppConfig;
let catalog: CatalogResult;
let persistQueue: Promise<void> = Promise.resolve();
let hookRefreshRequest = 0;
let persistTimer: number | null = null;
let previewFrame: number | null = null;
let pendingPreview: AppConfig | null = null;
let currentVersion = "";
let pendingUpdate: Update | null = null;
let updateInstalling = false;
const previewImageCache = new Map<string, Promise<string>>();
const configEventSource = `settings-${crypto.randomUUID()}`;

function input<T extends HTMLInputElement>(id: string): T { return document.querySelector<T>(`#${id}`)!; }

async function initialize(): Promise<void> {
  [config, currentVersion] = await Promise.all([invoke<AppConfig>("get_config"), getVersion()]);
  document.querySelector<HTMLElement>("#current-version")!.textContent = `v${currentVersion}`;
  bindConfig();
  await Promise.all([refreshCatalog(), refreshHookStatus(), refreshAutostart()]);
}

function showSettingsPage(page: SettingsPage, updateHash = true): void {
  const copy = settingsPageCopy[page];
  document.querySelector<HTMLElement>("#settings-page-eyebrow")!.textContent = copy.eyebrow;
  document.querySelector<HTMLElement>("#settings-page-title")!.textContent = copy.title;
  document.querySelector<HTMLElement>("#settings-page-description")!.textContent = copy.description;
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-settings-page]")) {
    const active = button.dataset.settingsPage === page;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  }
  for (const panel of document.querySelectorAll<HTMLElement>("[data-settings-panel]")) {
    panel.hidden = panel.dataset.settingsPanel !== page;
  }
  if (updateHash && window.location.hash !== `#${page}`) history.replaceState(null, "", `#${page}`);
}

async function checkForUpdates(): Promise<void> {
  const button = document.querySelector<HTMLButtonElement>("#check-update")!;
  const installButton = document.querySelector<HTMLButtonElement>("#install-update")!;
  const card = document.querySelector<HTMLElement>("#update-status-card")!;
  const icon = card.querySelector<HTMLElement>(".update-status-glyph")!;
  const title = document.querySelector<HTMLElement>("#update-status-title")!;
  const detail = document.querySelector<HTMLElement>("#update-status-detail")!;
  const progressElement = document.querySelector<HTMLElement>("#update-progress")!;
  const progressBar = document.querySelector<HTMLElement>("#update-progress-bar")!;
  await closePendingUpdate();
  button.disabled = true;
  button.textContent = "正在检查…";
  button.hidden = false;
  installButton.hidden = true;
  progressElement.hidden = true;
  progressBar.style.width = "0%";
  card.dataset.state = "checking";
  icon.textContent = "\u21bb";
  title.textContent = "正在检查更新";
  detail.textContent = "正在安全地读取更新信息…";
  let update: Update | null = null;
  try {
    update = await check();
    if (!update) {
      card.dataset.state = "current";
      icon.textContent = "\u2713";
      title.textContent = "已是最新版本";
      detail.textContent = `当前版本 v${currentVersion}，暂无可用更新。`;
      return;
    }

    card.dataset.state = "downloading";
    icon.textContent = "\u2193";
    title.textContent = `正在下载 v${update.version}`;
    detail.textContent = "正在准备下载…";
    button.hidden = true;
    progressElement.hidden = false;
    let progress = { ...emptyUpdateProgress };
    await update.download((event) => {
      progress = advanceUpdateProgress(progress, event);
      const percent = updateProgressPercent(progress);
      progressBar.style.width = `${percent ?? 0}%`;
      detail.textContent = percent === null
        ? `已下载 ${formatBytes(progress.downloaded)}`
        : `已下载 ${percent}% · ${formatBytes(progress.downloaded)} / ${formatBytes(progress.total!)}`;
    });

    pendingUpdate = update;
    card.dataset.state = "ready";
    icon.textContent = "\u2713";
    title.textContent = `v${update.version} 已准备好`;
    detail.textContent = "更新包已下载并通过签名验证，可以安全安装。";
    progressBar.style.width = "100%";
    button.hidden = true;
    installButton.hidden = false;
  } catch (error) {
    if (update && update !== pendingUpdate) await update.close().catch(() => undefined);
    card.dataset.state = "error";
    icon.textContent = "!";
    title.textContent = "暂时无法检查更新";
    detail.textContent = `${String(error)}。请检查网络后重试。`;
    progressElement.hidden = true;
    button.hidden = false;
  } finally {
    button.disabled = false;
    button.textContent = "再次检查";
  }
}

async function closePendingUpdate(): Promise<void> {
  const update = pendingUpdate;
  pendingUpdate = null;
  if (update) await update.close().catch(() => undefined);
}

async function installPendingUpdate(): Promise<void> {
  const update = pendingUpdate;
  if (!update) return;
  const button = document.querySelector<HTMLButtonElement>("#install-update")!;
  const card = document.querySelector<HTMLElement>("#update-status-card")!;
  const icon = card.querySelector<HTMLElement>(".update-status-glyph")!;
  const title = document.querySelector<HTMLElement>("#update-status-title")!;
  const detail = document.querySelector<HTMLElement>("#update-status-detail")!;
  updateInstalling = true;
  button.disabled = true;
  button.textContent = "正在安装…";
  card.dataset.state = "installing";
  icon.textContent = "\u21bb";
  title.textContent = `正在安装 v${update.version}`;
  detail.textContent = "安装完成后 Agent Cat 会自动重启。";
  let installed = false;
  try {
    await update.install();
    installed = true;
    pendingUpdate = null;
    await relaunch();
  } catch (error) {
    card.dataset.state = "error";
    icon.textContent = "!";
    title.textContent = installed ? "更新已安装" : "更新安装失败";
    detail.textContent = installed
      ? "自动重启失败，请手动重新打开 Agent Cat。"
      : `${String(error)}。下载内容仍然保留，可以重试安装。`;
    button.disabled = installed;
    button.textContent = installed ? "请手动重启" : "重试安装";
  } finally {
    updateInstalling = false;
  }
}

function bindConfig(): void {
  const scale = input<HTMLInputElement>("scale");
  scale.value = String(config.window.scale);
  input<HTMLOutputElement & HTMLInputElement>("scale-value").value = `${Math.round(config.window.scale * 100)}%`;
  input("pet-opacity").value = String(config.window.petOpacity);
  input<HTMLOutputElement & HTMLInputElement>("pet-opacity-value").value = `${Math.round(config.window.petOpacity * 100)}%`;
  input("bubble-scale").value = String(config.codex.bubbleScale);
  input<HTMLOutputElement & HTMLInputElement>("bubble-scale-value").value = `${Math.round(config.codex.bubbleScale * 100)}%`;
  input("bubble-opacity").value = String(config.codex.bubbleOpacity);
  input<HTMLOutputElement & HTMLInputElement>("bubble-opacity-value").value = `${Math.round(config.codex.bubbleOpacity * 100)}%`;
  input("always-on-top").checked = config.window.alwaysOnTop;
  input("mouse-passthrough").checked = config.window.mousePassthrough;
  input("lock-position").checked = config.window.lockPosition;
  input("follow-pointer").checked = config.behavior.followPointer;
  input("click-wave").checked = config.behavior.clickToWave;
  input("double-jump").checked = config.behavior.doubleClickToJump;
  input("codex-link").checked = config.codex.hooksEnabled;
  input("show-live-status").checked = config.codex.showLiveStatus;
  input("show-task-summary").checked = config.codex.showTaskSummary;
  input("show-task-summary").disabled = !config.codex.showLiveStatus;
  input("pointer-radius").value = String(config.behavior.pointerRadius);
  input<HTMLOutputElement & HTMLInputElement>("pointer-radius-value").value = `${config.behavior.pointerRadius}px`;
  input("pointer-deadzone").value = String(config.behavior.pointerDeadzone);
  input<HTMLOutputElement & HTMLInputElement>("pointer-deadzone-value").value = `${config.behavior.pointerDeadzone}px`;
  renderExtraDirectories();
}

function renderExtraDirectories(): void {
  const container = document.querySelector<HTMLElement>("#extra-directories")!;
  container.replaceChildren();
  for (const directory of config.petSources.extraDirectories) {
    const row = document.createElement("div");
    const path = document.createElement("code");
    path.textContent = directory;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "secondary compact";
    remove.textContent = "移除";
    remove.addEventListener("click", async () => {
      config.petSources.extraDirectories = config.petSources.extraDirectories.filter((value) => value !== directory);
      await persist();
      renderExtraDirectories();
      await refreshCatalog();
    });
    row.append(path, remove);
    container.append(row);
  }
}

function persist(announce = true): Promise<void> {
  if (persistTimer !== null) {
    window.clearTimeout(persistTimer);
    persistTimer = null;
  }
  const snapshot = structuredClone(config);
  const task = persistQueue.catch(() => undefined).then(async () => {
    await invoke("save_config", { value: snapshot });
    await invoke("apply_config_preview", { value: snapshot });
    await emit("agent-cat-config-changed", { source: configEventSource });
    if (announce) showMessage("已保存");
  });
  persistQueue = task;
  return task;
}

function schedulePersist(): void {
  if (persistTimer !== null) window.clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => {
    persistTimer = null;
    void persist(false).catch((error) => showMessage(String(error), true));
  }, 140);
}

function previewConfig(): void {
  const snapshot = structuredClone(config);
  pendingPreview = snapshot;
  void emit("agent-cat-config-preview", snapshot);
  if (previewFrame !== null) return;
  previewFrame = window.requestAnimationFrame(() => {
    previewFrame = null;
    const value = pendingPreview;
    pendingPreview = null;
    if (value) void invoke("apply_config_preview", { value }).catch((error) => showMessage(String(error), true));
  });
}

async function refreshCatalog(): Promise<void> {
  catalog = await invoke<CatalogResult>("scan_pets");
  summary.textContent = `${catalog.pets.length} 只可用宠物 · ${catalog.diagnostics.length} 个无效资源${catalog.codexBundles.length ? ` · Codex ${catalog.codexBundles[0].version ?? "未知版本"}` : " · 未发现 Codex.app"}`;
  catalogElement.replaceChildren();
  for (const source of ["codex-builtin", "codex-custom", "user-folder"] as PetSource[]) {
    const pets = catalog.pets.filter((pet) => pet.source === source);
    if (!pets.length) continue;
    const group = document.createElement("div");
    group.className = "pet-group";
    group.innerHTML = `<h3>${sourceLabels[source]}</h3><div class="pet-grid"></div>`;
    const grid = group.querySelector<HTMLElement>(".pet-grid")!;
    grid.append(...await Promise.all(pets.map(petCard)));
    catalogElement.append(group);
  }
  if (!catalog.pets.length) catalogElement.innerHTML = `<div class="empty-state">没有找到有效宠物。Agent Cat 会继续使用原创 CSS fallback cat。</div>`;
  if (catalog.diagnostics.length) {
    const details = document.createElement("details");
    details.innerHTML = `<summary>查看无效宠物</summary><ul>${catalog.diagnostics.map((item) => `<li><code>${escapeHtml(item.path)}</code><br>${escapeHtml(item.message)}</li>`).join("")}</ul>`;
    catalogElement.append(details);
  }
}

async function petCard(pet: PetDescriptor): Promise<HTMLElement> {
  const button = document.createElement("button");
  button.className = "pet-card";
  button.classList.toggle("selected", config.pet?.manifestPath === pet.manifestPath);
  button.title = pet.description ?? pet.displayName;
  const preview = document.createElement("span");
  preview.className = "pet-preview";
  try {
    let request = previewImageCache.get(pet.spritesheetPath);
    if (!request) {
      request = invoke<string>("load_sprite_data_url", { path: pet.spritesheetPath });
      previewImageCache.set(pet.spritesheetPath, request);
    }
    const image = await request;
    preview.style.backgroundImage = `url("${image}")`;
    preview.style.backgroundSize = `384px ${pet.version === 2 ? 572 : 468}px`;
  } catch {
    previewImageCache.delete(pet.spritesheetPath);
    preview.textContent = "?";
  }
  const label = document.createElement("span");
  label.innerHTML = `<strong>${escapeHtml(pet.displayName)}</strong><small>v${pet.version} · ${escapeHtml(pet.id)}</small>`;
  button.append(preview, label);
  button.addEventListener("click", async () => {
    if (config.pet?.manifestPath === pet.manifestPath) return;
    config.pet = { source: pet.source, id: pet.id, manifestPath: pet.manifestPath };
    for (const card of catalogElement.querySelectorAll(".pet-card.selected")) card.classList.remove("selected");
    button.classList.add("selected");
    await persist();
  });
  return button;
}

async function refreshHookStatus(): Promise<void> {
  const request = ++hookRefreshRequest;
  const card = document.querySelector<HTMLElement>("#codex-integration")!;
  const title = document.querySelector<HTMLElement>("#codex-integration-title")!;
  const detail = document.querySelector<HTMLElement>("#codex-integration-detail")!;
  const badge = document.querySelector<HTMLElement>("#codex-integration-badge")!;
  const hookElement = document.querySelector<HTMLElement>("#hook-status")!;
  const receiverElement = document.querySelector<HTMLElement>("#receiver-status")!;
  const eventElement = document.querySelector<HTMLElement>("#last-event-status")!;
  try {
    const [status, runtime] = await Promise.all([
      invoke<HookStatus>("hook_status"),
      invoke<HookRuntimeStatus>("hook_runtime_status"),
    ]);
    if (request !== hookRefreshRequest) return;
    const installed = status.installedEvents === status.expectedEvents;
    hookElement.textContent = installed ? `已安装 ${status.installedEvents}/${status.expectedEvents}` : `${status.installedEvents}/${status.expectedEvents}，需要安装`;
    hookElement.title = `${status.message} · ${status.path}`;
    hookElement.className = installed ? "status-ok" : "status-error";
    receiverElement.textContent = runtime.receiverRunning ? "运行中" : "未运行";
    receiverElement.title = runtime.socketPath;
    receiverElement.className = runtime.receiverRunning ? "status-ok" : "status-error";
    eventElement.textContent = runtime.lastEventAt
      ? `${eventLabels[runtime.lastEvent ?? ""] ?? runtime.lastEvent ?? "状态事件"} · ${relativeTime(runtime.lastEventAt)}${runtime.lastEventIsTest ? "（测试）" : ""}`
      : "尚未收到";

    if (!config.codex.hooksEnabled) {
      card.dataset.state = "paused";
      title.textContent = "Codex 状态联动已暂停";
      detail.textContent = "Hook 配置会保留；重新打开“Codex 工作状态联动”即可继续。";
      badge.textContent = "已暂停";
    } else if (!installed) {
      card.dataset.state = "setup";
      title.textContent = "还差一步即可连接 Codex";
      detail.textContent = "一键安装所需 Hook，并通过本地 Unix Socket 完成端到端测试。";
      badge.textContent = "未连接";
    } else if (!runtime.receiverRunning) {
      card.dataset.state = "error";
      title.textContent = "状态接收器未运行";
      detail.textContent = "Hook 配置完整，但本地接收器不可用；请重启 Agent Cat 后重新测试。";
      badge.textContent = "需重启";
    } else if (runtime.lastEventAt) {
      card.dataset.state = "connected";
      title.textContent = "Codex 状态联动正常";
      detail.textContent = runtime.lastEventIsTest ? "端到端测试已通过，正在等待真实 Codex 任务。" : "Agent Cat 已收到真实 Codex 状态事件。";
      badge.textContent = "已连接";
    } else {
      card.dataset.state = "ready";
      title.textContent = "Hook 已就绪，等待 Codex 事件";
      detail.textContent = "可以开始一个 Codex 任务，或点击“重新测试”检查完整链路。";
      badge.textContent = "已就绪";
    }
  } catch (error) {
    if (request !== hookRefreshRequest) return;
    card.dataset.state = "error";
    title.textContent = "无法检查 Codex 连接";
    detail.textContent = String(error);
    badge.textContent = "检查失败";
    hookElement.textContent = "检查失败";
    hookElement.className = "status-error";
    receiverElement.textContent = "未知";
    eventElement.textContent = "未知";
  }
}

function relativeTime(timestamp: number): string {
  const elapsed = Math.max(0, Date.now() - timestamp);
  if (elapsed < 10_000) return "刚刚";
  if (elapsed < 60_000) return `${Math.floor(elapsed / 1_000)} 秒前`;
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟前`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} 小时前`;
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(timestamp);
}

async function refreshAutostart(): Promise<void> {
  input("launch-at-login").checked = await invoke<boolean>("autostart_status");
}

function showMessage(value: string, isError = false): void {
  message.textContent = value;
  message.className = isError ? "status-error" : "status-ok";
  window.setTimeout(() => { message.textContent = ""; }, 2400);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]!);
}

input("scale").addEventListener("input", async (event) => {
  config.window.scale = Number((event.target as HTMLInputElement).value);
  input<HTMLOutputElement & HTMLInputElement>("scale-value").value = `${Math.round(config.window.scale * 100)}%`;
  previewConfig();
  schedulePersist();
});
input("pet-opacity").addEventListener("input", async (event) => {
  config.window.petOpacity = Number((event.target as HTMLInputElement).value);
  input<HTMLOutputElement & HTMLInputElement>("pet-opacity-value").value = `${Math.round(config.window.petOpacity * 100)}%`;
  previewConfig();
  schedulePersist();
});
input("bubble-scale").addEventListener("input", async (event) => {
  config.codex.bubbleScale = Number((event.target as HTMLInputElement).value);
  input<HTMLOutputElement & HTMLInputElement>("bubble-scale-value").value = `${Math.round(config.codex.bubbleScale * 100)}%`;
  previewConfig();
  schedulePersist();
});
input("bubble-opacity").addEventListener("input", async (event) => {
  config.codex.bubbleOpacity = Number((event.target as HTMLInputElement).value);
  input<HTMLOutputElement & HTMLInputElement>("bubble-opacity-value").value = `${Math.round(config.codex.bubbleOpacity * 100)}%`;
  previewConfig();
  schedulePersist();
});
input("pointer-radius").addEventListener("input", async (event) => {
  config.behavior.pointerRadius = Number((event.target as HTMLInputElement).value);
  input<HTMLOutputElement & HTMLInputElement>("pointer-radius-value").value = `${config.behavior.pointerRadius}px`;
  previewConfig();
  schedulePersist();
});
input("pointer-deadzone").addEventListener("input", async (event) => {
  config.behavior.pointerDeadzone = Number((event.target as HTMLInputElement).value);
  input<HTMLOutputElement & HTMLInputElement>("pointer-deadzone-value").value = `${config.behavior.pointerDeadzone}px`;
  previewConfig();
  schedulePersist();
});
for (const id of ["scale", "pet-opacity", "bubble-scale", "bubble-opacity", "pointer-radius", "pointer-deadzone"]) {
  input(id).addEventListener("change", () => void persist(false).catch((error) => showMessage(String(error), true)));
}
for (const [id, apply] of [
  ["always-on-top", (value: boolean) => config.window.alwaysOnTop = value],
  ["mouse-passthrough", (value: boolean) => config.window.mousePassthrough = value],
  ["lock-position", (value: boolean) => config.window.lockPosition = value],
  ["follow-pointer", (value: boolean) => config.behavior.followPointer = value],
  ["click-wave", (value: boolean) => config.behavior.clickToWave = value],
  ["double-jump", (value: boolean) => config.behavior.doubleClickToJump = value],
  ["codex-link", (value: boolean) => config.codex.hooksEnabled = value],
  ["show-live-status", (value: boolean) => {
    config.codex.showLiveStatus = value;
    input("show-task-summary").disabled = !value;
  }],
  ["show-task-summary", (value: boolean) => config.codex.showTaskSummary = value],
] as const) input(id).addEventListener("change", async (event) => {
  apply((event.target as HTMLInputElement).checked);
  await persist();
  if (id === "codex-link") await refreshHookStatus();
});

input("launch-at-login").addEventListener("change", async (event) => {
  const enabled = (event.target as HTMLInputElement).checked;
  try {
    await invoke("set_autostart", { enabled });
    await refreshAutostart();
    showMessage(enabled ? "已启用登录时启动" : "已关闭登录时启动");
  } catch (error) {
    await refreshAutostart();
    showMessage(String(error), true);
  }
});

document.querySelector("#refresh-pets")!.addEventListener("click", () => {
  previewImageCache.clear();
  void refreshCatalog();
});
document.querySelector("#add-directory")!.addEventListener("click", async () => {
  const value = input("extra-directory").value.trim();
  if (!value || config.petSources.extraDirectories.includes(value)) return;
  config.petSources.extraDirectories.push(value);
  await persist();
  input("extra-directory").value = "";
  renderExtraDirectories();
  await refreshCatalog();
});
document.querySelector("#open-codex-pets")!.addEventListener("click", () => void invoke("reveal_path", { path: "~/.codex/pets" }));
document.querySelector("#reset-position")!.addEventListener("click", async () => { config = await invoke<AppConfig>("reset_main_position"); bindConfig(); showMessage("位置已恢复"); });
document.querySelector("#connect-codex")!.addEventListener("click", async (event) => {
  const button = event.currentTarget as HTMLButtonElement;
  button.disabled = true;
  button.textContent = "正在连接…";
  try {
    await invoke("install_hooks");
    config.codex.hooksEnabled = true;
    config.codex.showLiveStatus = true;
    bindConfig();
    await persist();
    await invoke<HookRuntimeStatus>("probe_hook");
    await refreshHookStatus();
    showMessage("Codex 已连接，端到端测试通过");
  } catch (error) {
    await refreshHookStatus();
    showMessage(String(error), true);
  } finally {
    button.disabled = false;
    button.textContent = "一键连接并测试";
  }
});
document.querySelector("#install-hook")!.addEventListener("click", async () => { try { await invoke("install_hooks"); await refreshHookStatus(); showMessage("Hook 已安装；建议再运行一次连接测试"); } catch (error) { showMessage(String(error), true); } });
document.querySelector("#uninstall-hook")!.addEventListener("click", async () => { try { await invoke("uninstall_hooks"); await refreshHookStatus(); showMessage("Agent Cat Hook 已卸载"); } catch (error) { showMessage(String(error), true); } });
document.querySelector("#test-hook")!.addEventListener("click", async () => {
  try {
    await invoke<HookRuntimeStatus>("probe_hook");
    await refreshHookStatus();
    showMessage("端到端 Hook 测试通过");
  } catch (error) {
    await refreshHookStatus();
    showMessage(String(error), true);
  }
});
document.querySelector("#open-debug")!.addEventListener("click", () => void invoke("show_window", { kind: "pet-debug" }));
for (const button of document.querySelectorAll<HTMLButtonElement>("[data-settings-page]")) {
  button.addEventListener("click", () => showSettingsPage(button.dataset.settingsPage as SettingsPage));
}
document.querySelector("#check-update")!.addEventListener("click", () => void checkForUpdates());
document.querySelector("#install-update")!.addEventListener("click", () => void installPendingUpdate());
window.addEventListener("hashchange", () => {
  const page = window.location.hash.slice(1) as SettingsPage;
  if (page in settingsPageCopy) showSettingsPage(page, false);
});
void listen<{ source?: string }>("agent-cat-config-changed", async ({ payload }) => {
  if (payload?.source === configEventSource) return;
  config = await invoke<AppConfig>("get_config");
  bindConfig();
});
void listen("agent-cat-autostart-changed", () => void refreshAutostart());
const healthTimer = window.setInterval(() => void refreshHookStatus(), 5_000);
window.addEventListener("beforeunload", () => {
  window.clearInterval(healthTimer);
  if (persistTimer !== null) window.clearTimeout(persistTimer);
  if (previewFrame !== null) window.cancelAnimationFrame(previewFrame);
  if (!updateInstalling) void closePendingUpdate();
});
const initialPage = window.location.hash.slice(1) as SettingsPage;
showSettingsPage(initialPage in settingsPageCopy ? initialPage : "general");
void initialize().catch((error) => showMessage(String(error), true));
