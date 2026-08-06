import { describe, expect, it } from "vitest";
import messages from "./messages.json";
import { getLanguage, resolveLanguage, setLanguage, t } from ".";

describe("i18n", () => {
  it("contains complete English and Chinese translations", () => {
    for (const entry of Object.values(messages)) {
      expect(entry.en.trim()).not.toBe("");
      expect(entry.cn.trim()).not.toBe("");
    }
  });

  it("resolves system Chinese variants and defaults other languages to English", () => {
    expect(resolveLanguage("system", "zh-CN")).toBe("cn");
    expect(resolveLanguage("system", "zh-TW")).toBe("cn");
    expect(resolveLanguage("system", "en-US")).toBe("en");
    expect(resolveLanguage("cn", "en-US")).toBe("cn");
  });

  it("translates and interpolates named parameters", () => {
    setLanguage("cn");
    expect(getLanguage()).toBe("cn");
    expect(t("{agent} Connection", { agent: "Codex" })).toBe("Codex 连接");
    setLanguage("en");
    expect(t("{agent} Connection", { agent: "Codex" })).toBe("Codex Connection");
  });
});
