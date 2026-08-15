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
import {
  advanceUpdateProgress,
  emptyUpdateProgress,
  formatBytes,
  updateProgressPercent,
  type UpdateDownloadProgress,
} from "./update-progress";
import { AGENT_EVENT_CHANNEL, agentDisplayName, type RawAgentEvent } from "./agents";
import {
  localeTag,
  nativeMessages,
  setLanguage,
  t,
  translateDocument,
  type LanguagePreference,
  type MessageKey,
} from "./i18n";

type HookStatus = { path: string; exists: boolean; valid: boolean; globallyDisabled: boolean; installedEvents: number; expectedEvents: number; message: string };
type HookRuntimeStatus = { receiverRunning: boolean; socketPath: string; verifiedAt: number | null; lastRealEventAt: number | null; lastRealEvent: string | null };
type DshHookStatus = { harnessHome: string; patchPath: string; patchExists: boolean; pluginSourceExists: boolean; installed: boolean; message: string };
type PetDirectoryInfo = { defaultPath: string; examplePath: string };
type SettingsPage = "general" | "agents" | "about";
type IntegrationId = "codex" | "claude-code" | "dsh";
type IntegrationConfigKey = "codex" | "claudeCode" | "dsh";
type UpdatePresentation =
  | { phase: "idle" }
  | { phase: "available"; version: string }
  | { phase: "checking" }
  | { phase: "current" }
  | { phase: "downloading"; version: string; progress: UpdateDownloadProgress }
  | { phase: "ready"; version: string }
  | { phase: "check-error"; error: string }
  | { phase: "installing"; version: string }
  | { phase: "install-error"; error: string; installed: boolean };

const integrationIds = ["codex", "claude-code", "dsh"] as const satisfies readonly IntegrationId[];
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
  dsh: {
    configKey: "dsh", prefix: "dsh", iconUrl: new URL("../assets/agent-icons/dsh.svg", import.meta.url).href,
    linkId: "dsh-link", liveStatusId: "dsh-show-live-status", taskSummaryId: "dsh-show-task-summary",
    hookStatusId: "dsh-hook-status", receiverStatusId: "dsh-receiver-status", lastEventStatusId: "dsh-last-event-status",
    connectId: "connect-dsh", installId: "", uninstallId: "uninstall-dsh-hook", testId: "test-dsh-hook",
  },
};

const settingsPageCopy: Record<SettingsPage, { eyebrow: string; title: MessageKey; description: MessageKey }> = {
  general: { eyebrow: "PREFERENCES", title: "General", description: "Choose a pet and adjust how it behaves on your desktop." },
  agents: { eyebrow: "INTEGRATIONS", title: "Agents", description: "Choose an agent and manage its connection, live status, and task summaries." },
  about: { eyebrow: "ABOUT", title: "About", description: "View the Agent Cat version and software updates." },
};

const sourceLabels: Record<PetSource, MessageKey> = { "codex-builtin": "Codex built-in", "codex-custom": "Codex custom pets", "user-folder": "Other directories" };
const eventLabels: Record<string, MessageKey> = {
  SessionStart: "Session started",
  UserPromptSubmit: "Task received",
  PreToolUse: "Tool use started",
  PostToolUse: "Tool completed",
  PostToolUseFailure: "Tool failed",
  SubagentStart: "Collaboration started",
  SubagentStop: "Collaboration completed",
  PreCompact: "Compacting context",
  PostCompact: "Task resumed",
  PermissionRequest: "Waiting for confirmation",
  Stop: "Task completed",
  StopFailure: "Task ended with an error",
  SessionEnd: "Session ended",
  TurnInterrupted: "Task interrupted",
  HookParseError: "Parse failed",
};
const message = document.querySelector<HTMLElement>("#settings-message")!;
const catalogElement = document.querySelector<HTMLElement>("#pet-catalog")!;
const summary = document.querySelector<HTMLElement>("#catalog-summary")!;
const appIconUrl = new URL("../assets/app-icon.svg", import.meta.url).href;
for (const image of document.querySelectorAll<HTMLImageElement>(".settings-brand-mark, .about-logo")) image.src = appIconUrl;
let config: AppConfig;
let catalog: CatalogResult;
let persistQueue: Promise<void> = Promise.resolve();
const hookRefreshRequests: Record<IntegrationId, number> = { codex: 0, "claude-code": 0, dsh: 0 };
const hookRefreshTimers: Partial<Record<IntegrationId, number>> = {};
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
let updatePresentation: UpdatePresentation = { phase: "idle" };
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
    status.textContent = t("Checking");
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
  applyLanguage(config.language);
  document.querySelector<HTMLElement>("#current-version")!.textContent = `v${currentVersion}`;
  updateState = readUpdateState(localStorage, currentVersion);
  refreshUpdateIndicator();
  if (activeSettingsPage === "about") renderKnownUpdate();
  bindConfig();
  await Promise.all([refreshCatalog(), refreshHookStatus("codex"), refreshHookStatus("claude-code"), refreshHookStatus("dsh"), refreshAutostart()]);
}

function applyLanguage(preference: LanguagePreference): void {
  setLanguage(preference);
  translateDocument();
  if (currentVersion) document.querySelector<HTMLElement>("#current-version")!.textContent = `v${currentVersion}`;
  renderUpdatePresentation();
  applyPetDirectoryInfo();
  void invoke("sync_native_i18n", { value: nativeMessages() });
}

function applyPetDirectoryInfo(): void {
  if (!petDirectoryInfo) return;
  input("extra-directory").placeholder = petDirectoryInfo.examplePath;
  document.querySelector<HTMLButtonElement>("#open-codex-pets")!.title = petDirectoryInfo.defaultPath;
}

function showSettingsPage(page: SettingsPage, updateHash = true): void {
  activeSettingsPage = page;
  const copy = settingsPageCopy[page];
  document.querySelector<HTMLElement>("#settings-page-eyebrow")!.textContent = copy.eyebrow;
  document.querySelector<HTMLElement>("#settings-page-title")!.textContent = t(copy.title);
  document.querySelector<HTMLElement>("#settings-page-description")!.textContent = t(copy.description);
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

function renderUpdatePresentation(): void {
  const card = document.querySelector<HTMLElement>("#update-status-card")!;
  const icon = card.querySelector<HTMLElement>(".update-status-glyph")!;
  const title = document.querySelector<HTMLElement>("#update-status-title")!;
  const detail = document.querySelector<HTMLElement>("#update-status-detail")!;
  const progressElement = document.querySelector<HTMLElement>("#update-progress")!;
  const progressBar = document.querySelector<HTMLElement>("#update-progress-bar")!;
  const checkButton = document.querySelector<HTMLButtonElement>("#check-update")!;
  const installButton = document.querySelector<HTMLButtonElement>("#install-update")!;

  card.dataset.state = updatePresentation.phase === "available"
    ? "ready"
    : updatePresentation.phase === "check-error" || updatePresentation.phase === "install-error"
      ? "error"
      : updatePresentation.phase;
  checkButton.hidden = false;
  checkButton.disabled = false;
  installButton.hidden = true;
  installButton.disabled = false;
  progressElement.hidden = true;

  switch (updatePresentation.phase) {
    case "idle":
      icon.textContent = "\u21bb";
      title.textContent = t("Updates have not been checked");
      detail.textContent = t("New versions are downloaded in the background and wait for installation only after signature verification succeeds.");
      checkButton.textContent = t("Check for Updates");
      progressBar.style.width = "0%";
      break;
    case "available":
      icon.textContent = "\u2193";
      title.textContent = t("New version v{version} found", { version: updatePresentation.version });
      detail.textContent = t("The update package will be verified after download and then wait for installation.");
      checkButton.textContent = t("Download Update");
      break;
    case "checking":
      icon.textContent = "\u21bb";
      title.textContent = t("Checking for updates");
      detail.textContent = t("Securely retrieving update information…");
      checkButton.disabled = true;
      checkButton.textContent = t("Checking…");
      progressBar.style.width = "0%";
      break;
    case "current":
      icon.textContent = "\u2713";
      title.textContent = t("You are up to date");
      detail.textContent = t("The current version is v{version}. No updates are available.", { version: currentVersion });
      checkButton.textContent = t("Check Again");
      break;
    case "downloading": {
      const percent = updateProgressPercent(updatePresentation.progress);
      icon.textContent = "\u2193";
      title.textContent = t("Downloading v{version}", { version: updatePresentation.version });
      detail.textContent = updatePresentation.progress.downloaded === 0
        ? t("Preparing download…")
        : percent === null
          ? t("Downloaded {downloaded}", { downloaded: formatBytes(updatePresentation.progress.downloaded) })
          : t("Downloaded {percent}% · {downloaded} / {total}", {
            percent,
            downloaded: formatBytes(updatePresentation.progress.downloaded),
            total: formatBytes(updatePresentation.progress.total!),
          });
      progressBar.style.width = `${percent ?? 0}%`;
      progressElement.hidden = false;
      checkButton.hidden = true;
      break;
    }
    case "ready":
      icon.textContent = "\u2713";
      title.textContent = t("v{version} is ready", { version: updatePresentation.version });
      detail.textContent = t("The update package was downloaded and passed signature verification. It is safe to install.");
      progressBar.style.width = "100%";
      progressElement.hidden = false;
      checkButton.hidden = true;
      installButton.hidden = false;
      break;
    case "check-error":
      icon.textContent = "!";
      title.textContent = t("Unable to check for updates");
      detail.textContent = t("{error}. Check your network and try again.", { error: updatePresentation.error });
      checkButton.textContent = t("Check Again");
      break;
    case "installing":
      icon.textContent = "\u21bb";
      title.textContent = t("Installing v{version}", { version: updatePresentation.version });
      detail.textContent = t("Agent Cat will restart automatically after installation.");
      progressBar.style.width = "100%";
      progressElement.hidden = false;
      checkButton.hidden = true;
      installButton.hidden = false;
      installButton.disabled = true;
      installButton.textContent = t("Installing…");
      break;
    case "install-error":
      icon.textContent = "!";
      title.textContent = updatePresentation.installed ? t("Update installed") : t("Update installation failed");
      detail.textContent = updatePresentation.installed
        ? t("Automatic restart failed. Reopen Agent Cat manually.")
        : t("{error}. The download is still available, so you can retry installation.", { error: updatePresentation.error });
      progressBar.style.width = "100%";
      progressElement.hidden = false;
      checkButton.hidden = true;
      installButton.hidden = false;
      installButton.disabled = updatePresentation.installed;
      installButton.textContent = updatePresentation.installed ? t("Restart Manually") : t("Retry Installation");
      break;
  }
}

function renderKnownUpdate(): void {
  if (!updateState?.availableVersion) return;
  if (!pendingUpdate && !updateChecking) {
    updatePresentation = { phase: "available", version: updateState.availableVersion };
    renderUpdatePresentation();
  }
}

async function publishUpdateState(availableVersion: string | null): Promise<void> {
  updateState = recordUpdateCheck(localStorage, currentVersion, availableVersion);
  refreshUpdateIndicator();
  await emit(UPDATE_STATE_EVENT, updateState);
}

async function checkForUpdates(): Promise<void> {
  await closePendingUpdate();
  updateChecking = true;
  updatePresentation = { phase: "checking" };
  renderUpdatePresentation();
  let update: Update | null = null;
  try {
    update = await check();
    if (!update) {
      await publishUpdateState(null);
      updatePresentation = { phase: "current" };
      renderUpdatePresentation();
      return;
    }

    await publishUpdateState(update.version);

    let progress = { ...emptyUpdateProgress };
    updatePresentation = { phase: "downloading", version: update.version, progress };
    renderUpdatePresentation();
    await update.download((event) => {
      progress = advanceUpdateProgress(progress, event);
      updatePresentation = { phase: "downloading", version: update!.version, progress };
      renderUpdatePresentation();
    });

    pendingUpdate = update;
    updatePresentation = { phase: "ready", version: update.version };
    renderUpdatePresentation();
  } catch (error) {
    if (update && update !== pendingUpdate) await update.close().catch(() => undefined);
    updatePresentation = { phase: "check-error", error: String(error) };
    renderUpdatePresentation();
  } finally {
    updateChecking = false;
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
  updateInstalling = true;
  updatePresentation = { phase: "installing", version: update.version };
  renderUpdatePresentation();
  let installed = false;
  try {
    await update.install();
    installed = true;
    pendingUpdate = null;
    await publishUpdateState(null).catch(() => undefined);
    await relaunch();
  } catch (error) {
    updatePresentation = { phase: "install-error", error: String(error), installed };
    renderUpdatePresentation();
  } finally {
    updateInstalling = false;
  }
}

function bindConfig(): void {
  input<HTMLSelectElement & HTMLInputElement>("language").value = config.language;
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
  for (const agent of integrationIds) {
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
    remove.textContent = t("Remove");
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
    if (announce) showMessage(t("Saved"));
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
  summary.textContent = `${t("{pets} available pets · {invalid} invalid resources", { pets: catalog.pets.length, invalid: catalog.diagnostics.length })}${catalog.codexBundles.length ? ` · Codex ${catalog.codexBundles[0].version ?? t("Unknown version")}` : ` · ${t("Codex.app not found")}`}`;
  catalogElement.replaceChildren();
  for (const source of ["codex-builtin", "codex-custom", "user-folder"] as PetSource[]) {
    const pets = catalog.pets.filter((pet) => pet.source === source);
    if (!pets.length) continue;
    const group = document.createElement("div");
    group.className = "pet-group";
    group.innerHTML = `<h3>${t(sourceLabels[source])}</h3><div class="pet-grid"></div>`;
    const grid = group.querySelector<HTMLElement>(".pet-grid")!;
    grid.append(...await Promise.all(pets.map(petCard)));
    catalogElement.append(group);
  }
  if (!catalog.pets.length) catalogElement.innerHTML = `<div class="empty-state">${t("No valid pets were found. Agent Cat will continue using the original CSS fallback cat.")}</div>`;
  if (catalog.diagnostics.length) {
    const details = document.createElement("details");
    details.innerHTML = `<summary>${t("View invalid pets")}</summary><ul>${catalog.diagnostics.map((item) => `<li><code>${escapeHtml(item.path)}</code><br>${escapeHtml(item.message)}</li>`).join("")}</ul>`;
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
  if (agent === "dsh") return refreshDshStatus();
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
      ? t("Claude Code has disabled all Hooks globally")
      : installed ? t("Enable or pause {agent} status integration", { agent: displayName }) : t("Connect {agent} first", { agent: displayName });
    hookElement.textContent = !installed
      ? t("{installed}/{expected}, installation required", { installed: status.installedEvents, expected: status.expectedEvents })
      : status.globallyDisabled ? t("Claude Code has disabled all Hooks globally") : t("Installed {installed}/{expected}", { installed: status.installedEvents, expected: status.expectedEvents });
    hookElement.title = `${status.message} · ${status.path}`;
    hookElement.className = installed && !status.globallyDisabled ? "status-ok" : "status-error";
    receiverElement.textContent = runtime.receiverRunning ? t("Running") : t("Not running");
    receiverElement.title = runtime.socketPath;
    receiverElement.className = runtime.receiverRunning ? "status-ok" : "status-error";
    eventElement.textContent = runtime.lastRealEventAt
      ? `${eventLabels[runtime.lastRealEvent ?? ""] ? t(eventLabels[runtime.lastRealEvent ?? ""]) : runtime.lastRealEvent ?? t("Status event")} · ${relativeTime(runtime.lastRealEventAt)}`
      : runtime.verifiedAt
        ? t("No events received since launch")
        : t("No events received");

    if (!installed) {
      card.dataset.state = "setup";
      title.textContent = t("One more step to connect {agent}", { agent: displayName });
      detail.textContent = t("Install the required Hooks and complete an end-to-end test through the local status receiver.");
      badge.textContent = t("Not connected");
    } else if (status.globallyDisabled) {
      card.dataset.state = "error";
      title.textContent = t("Claude Code has disabled all Hooks globally");
      detail.textContent = t("Disable disableAllHooks in Claude Code settings, then return here and test the connection again.");
      badge.textContent = t("Globally disabled");
    } else if (!currentConfig.hooksEnabled) {
      card.dataset.state = "paused";
      title.textContent = t("{agent} status integration is paused", { agent: displayName });
      detail.textContent = t("The Hook configuration is preserved. Turn the Status integration switch above back on to resume.");
      badge.textContent = t("Paused");
    } else if (!runtime.receiverRunning) {
      card.dataset.state = "error";
      title.textContent = t("Status receiver is not running");
      detail.textContent = t("The Hook configuration is complete, but the local receiver is unavailable. Restart Agent Cat and test again.");
      badge.textContent = t("Restart required");
    } else if (runtime.verifiedAt) {
      card.dataset.state = "connected";
      title.textContent = t("{agent} status integration is working", { agent: displayName });
      detail.textContent = "";
      detail.hidden = true;
      badge.textContent = t("Connected");
    } else {
      card.dataset.state = "pending";
      title.textContent = t("Hook installed, waiting for verification");
      detail.textContent = t("Start a task in {agent} to verify a real event.", { agent: displayName });
      badge.textContent = t("Waiting for verification");
    }
  } catch (error) {
    if (request !== hookRefreshRequests[agent]) return;
    card.dataset.state = "error";
    title.textContent = t("Unable to check the {agent} connection", { agent: displayName });
    detail.textContent = String(error);
    badge.textContent = t("Check failed");
    hookElement.textContent = t("Check failed");
    hookElement.className = "status-error";
    receiverElement.textContent = t("Unknown");
    eventElement.textContent = t("Unknown");
    linkToggle.disabled = true;
    linkControl.title = t("Temporarily unable to check {agent} status integration", { agent: displayName });
  } finally {
    if (request === hookRefreshRequests[agent]) syncAgentNavigationState(agent);
  }
}

async function refreshDshStatus(): Promise<void> {
  const agent: IntegrationId = "dsh";
  const request = ++hookRefreshRequests[agent];
  const definition = integrationDefinitions[agent];
  const displayName = agentDisplayName(agent);
  const card = document.querySelector<HTMLElement>(`#${definition.prefix}-integration`)!;
  const title = document.querySelector<HTMLElement>(`#${definition.prefix}-integration-title`)!;
  const detail = document.querySelector<HTMLElement>(`#${definition.prefix}-integration-detail`)!;
  const badge = document.querySelector<HTMLElement>(`#${definition.prefix}-integration-badge`)!;
  const hookElement = document.querySelector<HTMLElement>(`#${definition.hookStatusId}`)!;
  const receiverElement = document.querySelector<HTMLElement>(`#${definition.receiverStatusId}`)!;
  const eventElement = document.querySelector<HTMLElement>(`#${definition.lastEventStatusId}`)!;
  const linkToggle = input(definition.linkId);
  const linkControl = linkToggle.closest<HTMLElement>(".agent-link-toggle")!;
  const testButton = document.querySelector<HTMLButtonElement>("#test-dsh-hook")!;
  detail.hidden = false;
  try {
    const [status, runtime] = await Promise.all([
      invoke<DshHookStatus>("dsh_hook_status"),
      invoke<HookRuntimeStatus>("hook_runtime_status", { agent }),
    ]);
    if (request !== hookRefreshRequests[agent]) return;
    linkToggle.disabled = !status.installed;
    testButton.disabled = !status.installed;
    linkControl.title = status.installed
      ? t("Enable or pause {agent} status integration", { agent: displayName })
      : t("Connect {agent} first", { agent: displayName });
    hookElement.textContent = status.installed ? t("Installed") : t("Not installed");
    hookElement.title = `${status.message} · ${status.patchPath}`;
    hookElement.className = status.installed ? "status-ok" : "status-error";
    receiverElement.textContent = runtime.receiverRunning ? t("Running") : t("Not running");
    receiverElement.title = runtime.socketPath;
    receiverElement.className = runtime.receiverRunning ? "status-ok" : "status-error";
    eventElement.textContent = runtime.lastRealEventAt
      ? `${eventLabels[runtime.lastRealEvent ?? ""] ? t(eventLabels[runtime.lastRealEvent ?? ""]) : runtime.lastRealEvent ?? t("Status event")} · ${relativeTime(runtime.lastRealEventAt)}`
      : runtime.verifiedAt
        ? t("No events received since launch")
        : t("No events received");

    if (!status.installed) {
      card.dataset.state = "setup";
      title.textContent = t("One more step to connect {agent}", { agent: displayName });
      detail.textContent = t("Install the dsh-session-agent-cat plugin into your DeepSeek Harness deployment, then complete an end-to-end test through the local status receiver.");
      badge.textContent = t("Not connected");
    } else if (!integrationConfig(agent).hooksEnabled) {
      card.dataset.state = "paused";
      title.textContent = t("{agent} status integration is paused", { agent: displayName });
      detail.textContent = t("The plugin is installed. Turn the Status integration switch above back on to resume.");
      badge.textContent = t("Paused");
    } else if (!runtime.receiverRunning) {
      card.dataset.state = "error";
      title.textContent = t("Status receiver is not running");
      detail.textContent = t("The local status receiver is unavailable. Restart Agent Cat and test again.");
      badge.textContent = t("Restart required");
    } else if (runtime.verifiedAt) {
      card.dataset.state = "connected";
      title.textContent = t("{agent} status integration is working", { agent: displayName });
      detail.textContent = "";
      detail.hidden = true;
      badge.textContent = t("Connected");
    } else {
      card.dataset.state = "pending";
      title.textContent = t("Plugin installed, waiting for verification");
      detail.textContent = t("Restart DeepSeek Harness to load the plugin, then start a task to verify a real event.");
      badge.textContent = t("Waiting for verification");
    }
  } catch (error) {
    if (request !== hookRefreshRequests[agent]) return;
    card.dataset.state = "error";
    title.textContent = t("Unable to check the {agent} connection", { agent: displayName });
    detail.textContent = String(error);
    badge.textContent = t("Check failed");
    hookElement.textContent = t("Check failed");
    hookElement.className = "status-error";
    receiverElement.textContent = t("Unknown");
    eventElement.textContent = t("Unknown");
    linkToggle.disabled = true;
    testButton.disabled = true;
    linkControl.title = t("Temporarily unable to check {agent} status integration", { agent: displayName });
  } finally {
    if (request === hookRefreshRequests[agent]) syncAgentNavigationState(agent);
  }
}

function relativeTime(timestamp: number): string {
  const elapsed = Math.max(0, Date.now() - timestamp);
  if (elapsed < 10_000) return t("Just now");
  if (elapsed < 60_000) return t("{count} seconds ago", { count: Math.floor(elapsed / 1_000) });
  if (elapsed < 3_600_000) return t("{count} minutes ago", { count: Math.floor(elapsed / 60_000) });
  if (elapsed < 86_400_000) return t("{count} hours ago", { count: Math.floor(elapsed / 3_600_000) });
  return new Intl.DateTimeFormat(localeTag(), { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(timestamp);
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

input("language").addEventListener("change", async (event) => {
  config.language = (event.target as HTMLSelectElement).value as LanguagePreference;
  applyLanguage(config.language);
  showSettingsPage(activeSettingsPage, false);
  renderExtraDirectories();
  await Promise.all([refreshCatalog(), refreshHookStatus("codex"), refreshHookStatus("claude-code"), refreshHookStatus("dsh")]);
  await persist();
});

for (const agent of integrationIds) {
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
    showMessage(enabled ? t("Launch at login enabled") : t("Launch at login disabled"));
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
    showMessage(t("Unable to open the pet directory: {error}", { error: String(error) }), true);
  }
});
document.querySelector("#reset-position")!.addEventListener("click", async () => { config = await invoke<AppConfig>("reset_main_position"); bindConfig(); showMessage(t("Position restored")); });
function bindIntegrationActions(agent: IntegrationId): void {
  const definition = integrationDefinitions[agent];
  const displayName = agentDisplayName(agent);

  document.querySelector(`#${definition.connectId}`)!.addEventListener("click", async (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    button.disabled = true;
    button.textContent = t("Connecting…");
    try {
      const status = await invoke<HookStatus>("install_hooks", { agent });
      if (status.globallyDisabled) {
        await refreshHookStatus(agent);
        showMessage(t("Claude Code has disabled all Hooks globally. Disable disableAllHooks first."), true);
        return;
      }
      const currentConfig = integrationConfig(agent);
      currentConfig.hooksEnabled = true;
      currentConfig.showLiveStatus = true;
      bindConfig();
      await persist();
      await invoke<HookRuntimeStatus>("probe_hook", { agent });
      await refreshHookStatus(agent);
      showMessage(t("Hook installed and local test passed. Waiting for a real {agent} event to verify.", { agent: displayName }));
    } catch (error) {
      await refreshHookStatus(agent);
      showMessage(String(error), true);
    } finally {
      button.disabled = false;
      button.textContent = t("Connect and Test");
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
          ? t("The Claude Code Hook was written, but disableAllHooks currently prevents it from running.")
          : t("The {agent} Hook is installed. Run the connection test again.", { agent: displayName }),
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
      showMessage(t("The Agent Cat Hook for {agent} was uninstalled", { agent: displayName }));
    } catch (error) { showMessage(String(error), true); }
  });
  document.querySelector(`#${definition.testId}`)!.addEventListener("click", async () => {
    try {
      const status = await invoke<HookStatus>("hook_status", { agent });
      if (status.globallyDisabled) throw new Error(t("Claude Code has disabled all Hooks globally. Disable disableAllHooks first."));
      await invoke<HookRuntimeStatus>("probe_hook", { agent });
      await refreshHookStatus(agent);
      showMessage(t("The local {agent} Hook test passed. Verification status is unchanged.", { agent: displayName }));
    } catch (error) {
      await refreshHookStatus(agent);
      showMessage(String(error), true);
    }
  });
}

bindIntegrationActions("codex");
bindIntegrationActions("claude-code");
document.querySelector("#test-dsh-hook")!.addEventListener("click", async () => {
  try {
    const status = await invoke<DshHookStatus>("dsh_hook_status");
    if (!status.installed) {
      throw new Error(t("Install the DeepSeek Harness plugin first, then run the test again."));
    }
    await invoke<HookRuntimeStatus>("probe_hook", { agent: "dsh" });
    await refreshHookStatus("dsh");
    showMessage(t("The local DeepSeek Harness plugin test passed. Verification status is unchanged."));
  } catch (error) {
    await refreshHookStatus("dsh");
    showMessage(String(error), true);
  }
});
document.querySelector("#connect-dsh")!.addEventListener("click", async (event) => {
  const button = event.currentTarget as HTMLButtonElement;
  const currentConfig = integrationConfig("dsh");
  const previousHooksEnabled = currentConfig.hooksEnabled;
  const previousShowLiveStatus = currentConfig.showLiveStatus;
  button.disabled = true;
  button.textContent = t("Connecting…");
  try {
    await invoke<DshHookStatus>("install_dsh_hooks");
    currentConfig.hooksEnabled = true;
    currentConfig.showLiveStatus = true;
    bindConfig();
    await persist();
    await invoke<HookRuntimeStatus>("probe_hook", { agent: "dsh" });
    await refreshHookStatus("dsh");
    showMessage(t("The DeepSeek Harness plugin was installed and the local test passed. Restart DeepSeek Harness to load the plugin, then start a task to verify."));
  } catch (error) {
    // Keep the in-memory config consistent with disk if persistence failed.
    currentConfig.hooksEnabled = previousHooksEnabled;
    currentConfig.showLiveStatus = previousShowLiveStatus;
    bindConfig();
    await refreshHookStatus("dsh");
    showMessage(String(error), true);
  } finally {
    button.disabled = false;
    button.textContent = t("Connect and Test");
  }
});
document.querySelector("#uninstall-dsh-hook")!.addEventListener("click", async (event) => {
  const button = event.currentTarget as HTMLButtonElement;
  button.disabled = true;
  try {
    await invoke<DshHookStatus>("uninstall_dsh_hooks");
    integrationConfig("dsh").hooksEnabled = false;
    bindConfig();
    await persist();
    await refreshHookStatus("dsh");
    showMessage(t("The DeepSeek Harness plugin was uninstalled"));
  } catch (error) {
    await refreshHookStatus("dsh");
    showMessage(String(error), true);
  } finally {
    button.disabled = false;
  }
});
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
  applyLanguage(config.language);
  bindConfig();
});
void listen("agent-cat-autostart-changed", () => void refreshAutostart());
void listen<RawAgentEvent>(AGENT_EVENT_CHANNEL, ({ payload }) => {
  if (!isIntegrationId(payload.agent)) return;
  // Agents can emit bursts (DeepSeek Harness especially: one tool/call and
  // tool/result per tool invocation), so coalesce UI refreshes per agent.
  const agent = payload.agent;
  const pending = hookRefreshTimers[agent];
  if (pending !== undefined) window.clearTimeout(pending);
  hookRefreshTimers[agent] = window.setTimeout(() => {
    delete hookRefreshTimers[agent];
    void refreshHookStatus(agent);
  }, 250);
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
  void refreshHookStatus("dsh");
}, 5_000);
window.addEventListener("beforeunload", () => {
  window.clearInterval(healthTimer);
  if (persistTimer !== null) window.clearTimeout(persistTimer);
  for (const timer of Object.values(hookRefreshTimers)) {
    if (timer !== undefined) window.clearTimeout(timer);
  }
  if (previewFrame !== null) window.cancelAnimationFrame(previewFrame);
  if (!updateInstalling) void closePendingUpdate();
});
showSettingsRoute();
void initialize().catch((error) => showMessage(String(error), true));
