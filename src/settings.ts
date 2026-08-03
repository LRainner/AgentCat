import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { emit, listen } from "@tauri-apps/api/event";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import type { AppConfig, CatalogResult, PetDescriptor, PetSource } from "./types";
import {
  hasAvailableUpdate,
  readUpdateState,
  recordUpdateCheck,
  UPDATE_STATE_EVENT,
  type UpdateIndicatorState,
} from "./update-indicator";
import { advanceUpdateProgress, emptyUpdateProgress, formatBytes, updateProgressPercent } from "./update-progress";
import { AGENT_EVENT_CHANNEL, agentDisplayName, type RawAgentEvent } from "./agents";

type HookStatus = { path: string; exists: boolean; valid: boolean; globallyDisabled: boolean; installedEvents: number; expectedEvents: number; message: string };
type HookRuntimeStatus = { receiverRunning: boolean; socketPath: string; verifiedAt: number | null; lastRealEventAt: number | null; lastRealEvent: string | null };
type PetDirectoryInfo = { defaultPath: string; examplePath: string };
type SettingsPage = "general" | "agents" | "about";
type IntegrationId = "codex" | "claude-code";
type IntegrationConfigKey = "codex" | "claudeCode";

const integrationIds = ["codex", "claude-code"] as const satisfies readonly IntegrationId[];
const agentSettingsStorageKey = "agent-cat-settings-agent";

const integrationDefinitions: Record<IntegrationId, {
  configKey: IntegrationConfigKey;
  prefix: string;
  iconUrl: string;
  linkId: string;
  liveStatusId: string;
  taskSummaryId: string;
  hookStatusId: string;
  receiverStatusId: string;
  lastEventStatusId: string;
  connectId: string;
  installId: string;
  uninstallId: string;
  testId: string;
}> = {
  codex: {
    configKey: "codex", prefix: "codex", iconUrl: new URL("../assets/agent-icons/codex.svg", import.meta.url).href,
    linkId: "codex-link", liveStatusId: "show-live-status", taskSummaryId: "show-task-summary",
    hookStatusId: "hook-status", receiverStatusId: "receiver-status", lastEventStatusId: "last-event-status",
    connectId: "connect-codex", installId: "install-hook", uninstallId: "uninstall-hook", testId: "test-hook",
  },
  "claude-code": {
    configKey: "claudeCode", prefix: "claude-code", iconUrl: new URL("../assets/agent-icons/claude-code.svg", import.meta.url).href,
    linkId: "claude-code-link", liveStatusId: "claude-code-show-live-status", taskSummaryId: "claude-code-show-task-summary",
    hookStatusId: "claude-code-hook-status", receiverStatusId: "claude-code-receiver-status", lastEventStatusId: "claude-code-last-event-status",
    connectId: "connect-claude-code", installId: "install-claude-code-hook", uninstallId: "uninstall-claude-code-hook", testId: "test-claude-code-hook",
  },
};

const settingsPageCopy: Record<SettingsPage, { eyebrow: string; title: string; description: string }> = {
  general: { eyebrow: "PREFERENCES", title: "通用", description: "选择宠物并调整它在桌面上的表现。" },
  agents: { eyebrow: "INTEGRATIONS", title: "智能体", description: "选择智能体并管理连接、实时状态和任务摘要。" },
  about: { eyebrow: "ABOUT", title: "关于", description: "查看 Agent Cat 版本和软件更新。" },
};

const sourceLabels: Record<PetSource, string> = { "codex-builtin": "Codex 内置", "codex-custom": "Codex 自定义宠物", "user-folder": "其他目录" };
const eventLabels: Record<string, string> = {
  SessionStart: "会话开始",
  UserPromptSubmit: "收到任务",
  PreToolUse: "开始使用工具",
  PostToolUse: "工具执行完成",
  PostToolUseFailure: "工具执行失败",
  SubagentStart: "协作开始",
  SubagentStop: "协作完成",
  PreCompact: "整理上下文",
  PostCompact: "继续任务",
  PermissionRequest: "等待确认",
  Stop: "任务完成",
  StopFailure: "任务异常结束",
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
const hookRefreshRequests: Record<IntegrationId, number> = { codex: 0, "claude-code": 0 };
let persistTimer: number | null = null;
let previewFrame: number | null = null;
let pendingPreview: AppConfig | null = null;
let currentVersion = "";
let pendingUpdate: Update | null = null;
let updateChecking = false;
let updateInstalling = false;
let activeSettingsPage: SettingsPage = "general";
let activeAgentSettings: IntegrationId = readStoredAgentSettings();
let updateState: UpdateIndicatorState | null = null;
let petDirectoryInfo: PetDirectoryInfo;
const previewImageCache = new Map<string, Promise<string>>();
const configEventSource = `settings-${crypto.randomUUID()}`;

function input<T extends HTMLInputElement>(id: string): T { return document.querySelector<T>(`#${id}`)!; }

function integrationConfig(agent: IntegrationId): AppConfig[IntegrationConfigKey] {
  return config[integrationDefinitions[agent].configKey];
}

function isIntegrationId(value: string): value is IntegrationId {
  return integrationIds.some((agent) => agent === value);
}

function readStoredAgentSettings(): IntegrationId {
  const stored = localStorage.getItem(agentSettingsStorageKey);
  return stored && isIntegrationId(stored) ? stored : integrationIds[0];
}

function renderAgentSettingsNavigation(): void {
  const navigation = document.querySelector<HTMLElement>("#agent-settings-nav")!;
  navigation.replaceChildren(...integrationIds.map((agent) => {
    const definition = integrationDefinitions[agent];
    const displayName = agentDisplayName(agent);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "agent-nav-item";
    button.dataset.agentSettings = agent;
    button.setAttribute("role", "tab");
    button.setAttribute("aria-controls", `agent-settings-${agent}`);
    button.setAttribute("aria-selected", "false");

    const icon = document.createElement("span");
    icon.className = "agent-nav-icon";
    icon.setAttribute("aria-hidden", "true");
    const image = document.createElement("img");
    image.src = definition.iconUrl;
    image.alt = "";
    icon.append(image);

    const copy = document.createElement("span");
    const name = document.createElement("strong");
    name.textContent = displayName;
    const status = document.createElement("small");
    status.dataset.agentStatus = agent;
    status.textContent = "检查中";
    copy.append(name, status);
    button.append(icon, copy);
    button.addEventListener("click", () => showAgentSettings(agent));
    return button;
  }));
}

function showAgentSettings(agent: IntegrationId, updateHash = true): void {
  activeAgentSettings = agent;
  localStorage.setItem(agentSettingsStorageKey, agent);
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-agent-settings]")) {
    const active = button.dataset.agentSettings === agent;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  }
  for (const panel of document.querySelectorAll<HTMLElement>("[data-agent-panel]")) {
    panel.hidden = panel.dataset.agentPanel !== agent;
  }
  if (updateHash) history.replaceState(null, "", `#agents/${agent}`);
}

function syncAgentNavigationState(agent: IntegrationId): void {
  const definition = integrationDefinitions[agent];
  const card = document.querySelector<HTMLElement>(`#${definition.prefix}-integration`)!;
  const button = document.querySelector<HTMLButtonElement>(`[data-agent-settings="${agent}"]`)!;
  const status = button.querySelector<HTMLElement>("[data-agent-status]")!;
  button.dataset.state = card.dataset.state ?? "checking";
  status.textContent = document.querySelector<HTMLElement>(`#${definition.prefix}-integration-badge`)!.textContent;
}

async function initialize(): Promise<void> {
  [config, currentVersion, petDirectoryInfo] = await Promise.all([
    invoke<AppConfig>("get_config"),
    getVersion(),
    invoke<PetDirectoryInfo>("pet_directory_info"),
  ]);
  input("extra-directory").placeholder = petDirectoryInfo.examplePath;
  document.querySelector<HTMLButtonElement>("#open-codex-pets")!.title = petDirectoryInfo.defaultPath;
  document.querySelector<HTMLElement>("#current-version")!.textContent = `v${currentVersion}`;
  updateState = readUpdateState(localStorage, currentVersion);
  refreshUpdateIndicator();
  if (activeSettingsPage === "about") renderKnownUpdate();
  bindConfig();
  await Promise.all([refreshCatalog(), refreshHookStatus("codex"), refreshHookStatus("claude-code"), refreshAutostart()]);
}

function showSettingsPage(page: SettingsPage, updateHash = true): void {
  activeSettingsPage = page;
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
  if (page === "agents") showAgentSettings(activeAgentSettings, false);
  const hash = page === "agents" ? `#agents/${activeAgentSettings}` : `#${page}`;
  if (updateHash && window.location.hash !== hash) history.replaceState(null, "", hash);
  if (page === "about" && currentVersion) renderKnownUpdate();
}

function showSettingsRoute(): void {
  const route = window.location.hash.slice(1);
  if (route === "general" || route === "about") {
    showSettingsPage(route, false);
    return;
  }
  if (route.startsWith("agents/")) {
    const agent = route.slice("agents/".length);
    if (isIntegrationId(agent)) activeAgentSettings = agent;
    showSettingsPage("agents", !isIntegrationId(agent));
    return;
  }
  if (route === "agents") {
    showSettingsPage("agents");
    return;
  }
  const legacyAgent = route === "codex" ? "codex" : route === "claude" ? "claude-code" : null;
  if (legacyAgent) {
    activeAgentSettings = legacyAgent;
    showSettingsPage("agents");
    return;
  }
  showSettingsPage("general", route !== "");
}

function refreshUpdateIndicator(): void {
  document.querySelector<HTMLElement>("#about-update-dot")!.hidden = !hasAvailableUpdate(updateState);
}

function renderKnownUpdate(): void {
  if (!updateState?.availableVersion) return;
  if (!pendingUpdate && !updateChecking) {
    const card = document.querySelector<HTMLElement>("#update-status-card")!;
    card.dataset.state = "ready";
    card.querySelector<HTMLElement>(".update-status-glyph")!.textContent = "\u2193";
    document.querySelector<HTMLElement>("#update-status-title")!.textContent = `发现新版本 v${updateState.availableVersion}`;
    document.querySelector<HTMLElement>("#update-status-detail")!.textContent = "点击下载后将验证更新包，并等待安装。";
    const button = document.querySelector<HTMLButtonElement>("#check-update")!;
    button.textContent = "下载更新";
  }
}

async function publishUpdateState(availableVersion: string | null): Promise<void> {
  updateState = recordUpdateCheck(localStorage, currentVersion, availableVersion);
  refreshUpdateIndicator();
  await emit(UPDATE_STATE_EVENT, updateState);
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
  updateChecking = true;
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
      await publishUpdateState(null);
      card.dataset.state = "current";
      icon.textContent = "\u2713";
      title.textContent = "已是最新版本";
      detail.textContent = `当前版本 v${currentVersion}，暂无可用更新。`;
      return;
    }

    await publishUpdateState(update.version);

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
    updateChecking = false;
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
    await publishUpdateState(null).catch(() => undefined);
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
  for (const agent of ["codex", "claude-code"] as const) {
    const definition = integrationDefinitions[agent];
    const currentConfig = integrationConfig(agent);
    input(definition.linkId).checked = currentConfig.hooksEnabled;
    input(definition.liveStatusId).checked = currentConfig.showLiveStatus;
    input(definition.taskSummaryId).checked = currentConfig.showTaskSummary;
    input(definition.taskSummaryId).disabled = !currentConfig.showLiveStatus;
  }
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

async function refreshHookStatus(agent: IntegrationId): Promise<void> {
  const request = ++hookRefreshRequests[agent];
  const definition = integrationDefinitions[agent];
  const displayName = agentDisplayName(agent);
  const currentConfig = integrationConfig(agent);
  const card = document.querySelector<HTMLElement>(`#${definition.prefix}-integration`)!;
  const title = document.querySelector<HTMLElement>(`#${definition.prefix}-integration-title`)!;
  const detail = document.querySelector<HTMLElement>(`#${definition.prefix}-integration-detail`)!;
  const badge = document.querySelector<HTMLElement>(`#${definition.prefix}-integration-badge`)!;
  const hookElement = document.querySelector<HTMLElement>(`#${definition.hookStatusId}`)!;
  const receiverElement = document.querySelector<HTMLElement>(`#${definition.receiverStatusId}`)!;
  const eventElement = document.querySelector<HTMLElement>(`#${definition.lastEventStatusId}`)!;
  const linkToggle = input(definition.linkId);
  const linkControl = linkToggle.closest<HTMLElement>(".agent-link-toggle")!;
  detail.hidden = false;
  try {
    const [status, runtime] = await Promise.all([
      invoke<HookStatus>("hook_status", { agent }),
      invoke<HookRuntimeStatus>("hook_runtime_status", { agent }),
    ]);
    if (request !== hookRefreshRequests[agent]) return;
    const installed = status.installedEvents === status.expectedEvents;
    linkToggle.disabled = !installed || status.globallyDisabled;
    linkControl.title = status.globallyDisabled
      ? "Claude Code 已全局禁用所有 Hooks"
      : installed ? `启用或暂停 ${displayName} 状态联动` : `请先连接 ${displayName}`;
    hookElement.textContent = !installed
      ? `${status.installedEvents}/${status.expectedEvents}，需要安装`
      : status.globallyDisabled ? "Claude Code 已全局禁用所有 Hooks" : `已安装 ${status.installedEvents}/${status.expectedEvents}`;
    hookElement.title = `${status.message} · ${status.path}`;
    hookElement.className = installed && !status.globallyDisabled ? "status-ok" : "status-error";
    receiverElement.textContent = runtime.receiverRunning ? "运行中" : "未运行";
    receiverElement.title = runtime.socketPath;
    receiverElement.className = runtime.receiverRunning ? "status-ok" : "status-error";
    eventElement.textContent = runtime.lastRealEventAt
      ? `${eventLabels[runtime.lastRealEvent ?? ""] ?? runtime.lastRealEvent ?? "状态事件"} · ${relativeTime(runtime.lastRealEventAt)}`
      : runtime.verifiedAt
        ? "本次启动尚未收到"
        : "尚未收到";

    if (!installed) {
      card.dataset.state = "setup";
      title.textContent = `还差一步即可连接 ${displayName}`;
      detail.textContent = "一键安装所需 Hook，并通过本地状态接收器完成端到端测试。";
      badge.textContent = "未连接";
    } else if (status.globallyDisabled) {
      card.dataset.state = "error";
      title.textContent = "Claude Code 已全局禁用所有 Hooks";
      detail.textContent = "请先在 Claude Code 设置中关闭 disableAllHooks，再回来重新测试连接。";
      badge.textContent = "全局禁用";
    } else if (!currentConfig.hooksEnabled) {
      card.dataset.state = "paused";
      title.textContent = `${displayName} 状态联动已暂停`;
      detail.textContent = "Hook 配置会保留；重新打开上方“状态联动”开关即可继续。";
      badge.textContent = "已暂停";
    } else if (!runtime.receiverRunning) {
      card.dataset.state = "error";
      title.textContent = "状态接收器未运行";
      detail.textContent = "Hook 配置完整，但本地接收器不可用；请重启 Agent Cat 后重新测试。";
      badge.textContent = "需重启";
    } else if (runtime.verifiedAt) {
      card.dataset.state = "connected";
      title.textContent = `${displayName} 状态联动正常`;
      detail.textContent = "";
      detail.hidden = true;
      badge.textContent = "已连接";
    } else {
      card.dataset.state = "pending";
      title.textContent = "Hook 已安装，等待验证";
      detail.textContent = `请在 ${displayName} 中开始一个任务，以完成真实事件验证。`;
      badge.textContent = "待验证";
    }
  } catch (error) {
    if (request !== hookRefreshRequests[agent]) return;
    card.dataset.state = "error";
    title.textContent = `无法检查 ${displayName} 连接`;
    detail.textContent = String(error);
    badge.textContent = "检查失败";
    hookElement.textContent = "检查失败";
    hookElement.className = "status-error";
    receiverElement.textContent = "未知";
    eventElement.textContent = "未知";
    linkToggle.disabled = true;
    linkControl.title = `暂时无法检查 ${displayName} 状态联动`;
  } finally {
    if (request === hookRefreshRequests[agent]) syncAgentNavigationState(agent);
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
] as const) input(id).addEventListener("change", async (event) => {
  apply((event.target as HTMLInputElement).checked);
  await persist();
});

for (const agent of ["codex", "claude-code"] as const) {
  const definition = integrationDefinitions[agent];
  input(definition.linkId).addEventListener("change", async (event) => {
    integrationConfig(agent).hooksEnabled = (event.target as HTMLInputElement).checked;
    await persist();
    await refreshHookStatus(agent);
  });
  input(definition.liveStatusId).addEventListener("change", async (event) => {
    const enabled = (event.target as HTMLInputElement).checked;
    integrationConfig(agent).showLiveStatus = enabled;
    input(definition.taskSummaryId).disabled = !enabled;
    await persist();
  });
  input(definition.taskSummaryId).addEventListener("change", async (event) => {
    integrationConfig(agent).showTaskSummary = (event.target as HTMLInputElement).checked;
    await persist();
  });
}

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
document.querySelector("#open-codex-pets")!.addEventListener("click", async () => {
  try {
    await invoke("reveal_pet_directory");
  } catch (error) {
    showMessage(`无法打开宠物目录：${String(error)}`, true);
  }
});
document.querySelector("#reset-position")!.addEventListener("click", async () => { config = await invoke<AppConfig>("reset_main_position"); bindConfig(); showMessage("位置已恢复"); });
function bindIntegrationActions(agent: IntegrationId): void {
  const definition = integrationDefinitions[agent];
  const displayName = agentDisplayName(agent);

  document.querySelector(`#${definition.connectId}`)!.addEventListener("click", async (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    button.disabled = true;
    button.textContent = "正在连接…";
    try {
      const status = await invoke<HookStatus>("install_hooks", { agent });
      if (status.globallyDisabled) {
        await refreshHookStatus(agent);
        showMessage("Claude Code 已全局禁用所有 Hooks，请先关闭 disableAllHooks", true);
        return;
      }
      const currentConfig = integrationConfig(agent);
      currentConfig.hooksEnabled = true;
      currentConfig.showLiveStatus = true;
      bindConfig();
      await persist();
      await invoke<HookRuntimeStatus>("probe_hook", { agent });
      await refreshHookStatus(agent);
      showMessage(`Hook 已安装，本地测试通过；等待真实 ${displayName} 事件验证`);
    } catch (error) {
      await refreshHookStatus(agent);
      showMessage(String(error), true);
    } finally {
      button.disabled = false;
      button.textContent = "一键连接并测试";
    }
  });
  document.querySelector(`#${definition.installId}`)!.addEventListener("click", async () => {
    try {
      const status = await invoke<HookStatus>("hook_status", { agent });
      const wasInstalled = status.installedEvents === status.expectedEvents;
      const installedStatus = await invoke<HookStatus>("install_hooks", { agent });
      if (!wasInstalled && !installedStatus.globallyDisabled) {
        integrationConfig(agent).hooksEnabled = true;
        bindConfig();
        await persist();
      }
      await refreshHookStatus(agent);
      showMessage(
        installedStatus.globallyDisabled
          ? "Claude Code Hook 已写入，但 disableAllHooks 当前会阻止它运行"
          : `${displayName} Hook 已安装；建议再运行一次连接测试`,
        installedStatus.globallyDisabled,
      );
    } catch (error) { showMessage(String(error), true); }
  });
  document.querySelector(`#${definition.uninstallId}`)!.addEventListener("click", async () => {
    try {
      await invoke("uninstall_hooks", { agent });
      integrationConfig(agent).hooksEnabled = false;
      bindConfig();
      await persist();
      await refreshHookStatus(agent);
      showMessage(`${displayName} 的 Agent Cat Hook 已卸载`);
    } catch (error) { showMessage(String(error), true); }
  });
  document.querySelector(`#${definition.testId}`)!.addEventListener("click", async () => {
    try {
      const status = await invoke<HookStatus>("hook_status", { agent });
      if (status.globallyDisabled) throw new Error("Claude Code 已全局禁用所有 Hooks，请先关闭 disableAllHooks");
      await invoke<HookRuntimeStatus>("probe_hook", { agent });
      await refreshHookStatus(agent);
      showMessage(`${displayName} 本地 Hook 测试通过；验证状态保持不变`);
    } catch (error) {
      await refreshHookStatus(agent);
      showMessage(String(error), true);
    }
  });
}

bindIntegrationActions("codex");
bindIntegrationActions("claude-code");
document.querySelector("#open-debug")!.addEventListener("click", () => void invoke("show_window", { kind: "pet-debug" }));
renderAgentSettingsNavigation();
for (const button of document.querySelectorAll<HTMLButtonElement>("[data-settings-page]")) {
  button.addEventListener("click", () => showSettingsPage(button.dataset.settingsPage as SettingsPage));
}
document.querySelector("#check-update")!.addEventListener("click", () => void checkForUpdates());
document.querySelector("#install-update")!.addEventListener("click", () => void installPendingUpdate());
window.addEventListener("hashchange", showSettingsRoute);
void listen<{ source?: string }>("agent-cat-config-changed", async ({ payload }) => {
  if (payload?.source === configEventSource) return;
  config = await invoke<AppConfig>("get_config");
  bindConfig();
});
void listen("agent-cat-autostart-changed", () => void refreshAutostart());
void listen<RawAgentEvent>(AGENT_EVENT_CHANNEL, ({ payload }) => {
  if (payload.agent === "codex" || payload.agent === "claude-code") void refreshHookStatus(payload.agent);
});
void listen<UpdateIndicatorState>(UPDATE_STATE_EVENT, ({ payload }) => {
  if (payload.checkedFromVersion !== currentVersion) return;
  updateState = payload;
  refreshUpdateIndicator();
  if (activeSettingsPage === "about") renderKnownUpdate();
});
const healthTimer = window.setInterval(() => {
  void refreshHookStatus("codex");
  void refreshHookStatus("claude-code");
}, 5_000);
window.addEventListener("beforeunload", () => {
  window.clearInterval(healthTimer);
  if (persistTimer !== null) window.clearTimeout(persistTimer);
  if (previewFrame !== null) window.cancelAnimationFrame(previewFrame);
  if (!updateInstalling) void closePendingUpdate();
});
showSettingsRoute();
void initialize().catch((error) => showMessage(String(error), true));
