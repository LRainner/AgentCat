import messages from "./messages.json";

export type Language = "en" | "cn";
export type LanguagePreference = "system" | Language;
export type MessageKey = keyof typeof messages;
export type MessageParameters = Record<string, string | number>;

let activeLanguage: Language = "cn";

export function resolveLanguage(preference: LanguagePreference, systemLanguage?: string): Language {
  if (preference !== "system") return preference;
  const detected = systemLanguage ?? (typeof navigator === "undefined" ? "en" : navigator.language);
  return detected.toLowerCase().startsWith("zh") ? "cn" : "en";
}

export function setLanguage(preference: LanguagePreference, systemLanguage?: string): Language {
  activeLanguage = resolveLanguage(preference, systemLanguage);
  if (typeof document !== "undefined") document.documentElement.lang = activeLanguage === "cn" ? "zh-CN" : "en";
  return activeLanguage;
}

export function getLanguage(): Language {
  return activeLanguage;
}

export function localeTag(): string {
  return activeLanguage === "cn" ? "zh-CN" : "en";
}

export function t(key: MessageKey, parameters: MessageParameters = {}): string {
  const entry = messages[key];
  const template = entry?.[activeLanguage] ?? entry?.en ?? key;
  return template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(parameters, name) ? String(parameters[name]) : match,
  );
}

function setDirectText(element: HTMLElement, value: string): void {
  const textNode = [...element.childNodes].find((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim());
  if (textNode) {
    const leading = textNode.textContent?.match(/^\s*/)?.[0] ?? "";
    const trailing = textNode.textContent?.match(/\s*$/)?.[0] ?? "";
    textNode.textContent = `${leading}${value}${trailing}`;
    return;
  }
  element.prepend(document.createTextNode(value));
}

export function translateDocument(root: ParentNode = document): void {
  for (const element of root.querySelectorAll<HTMLElement>("[data-i18n]")) {
    setDirectText(element, t(element.dataset.i18n as MessageKey));
  }
  for (const [attribute, dataAttribute] of [["title", "i18nTitle"], ["aria-label", "i18nAriaLabel"], ["placeholder", "i18nPlaceholder"]] as const) {
    for (const element of root.querySelectorAll<HTMLElement>(`[data-${dataAttribute.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}]`)) {
      const key = element.dataset[dataAttribute] as MessageKey | undefined;
      if (key) element.setAttribute(attribute, t(key));
    }
  }
}

export type NativeMessages = {
  settingsTitle: string;
  statusTitle: string;
  debugTitle: string;
  showPet: string;
  settings: string;
  alwaysOnTop: string;
  mousePassthrough: string;
  lockPosition: string;
  launchAtLogin: string;
  quit: string;
};

export function nativeMessages(): NativeMessages {
  return {
    settingsTitle: t("Agent Cat Settings"),
    statusTitle: t("Agent Cat Live Status"),
    debugTitle: t("Agent Cat Animation Tester"),
    showPet: t("Show Pet"),
    settings: t("Settings…"),
    alwaysOnTop: t("Always on top"),
    mousePassthrough: t("Mouse passthrough"),
    lockPosition: t("Lock position"),
    launchAtLogin: t("Launch at login"),
    quit: t("Quit Agent Cat"),
  };
}
