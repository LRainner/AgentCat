import { describe, expect, it } from "vitest";
import { advanceUpdateProgress, emptyUpdateProgress, formatBytes, updateProgressPercent } from "./update-progress";

describe("update download progress", () => {
  it("tracks a download with a known size", () => {
    let progress = advanceUpdateProgress(emptyUpdateProgress, { event: "Started", data: { contentLength: 200 } });
    progress = advanceUpdateProgress(progress, { event: "Progress", data: { chunkLength: 50 } });
    expect(progress).toMatchObject({ downloaded: 50, total: 200, finished: false });
    expect(updateProgressPercent(progress)).toBe(25);
  });

  it("supports unknown sizes and marks completion", () => {
    let progress = advanceUpdateProgress(emptyUpdateProgress, { event: "Started", data: {} });
    progress = advanceUpdateProgress(progress, { event: "Progress", data: { chunkLength: 1024 } });
    progress = advanceUpdateProgress(progress, { event: "Finished" });
    expect(progress).toMatchObject({ downloaded: 1024, total: null, finished: true });
    expect(updateProgressPercent(progress)).toBeNull();
    expect(formatBytes(progress.downloaded)).toBe("1.0 KB");
  });

  it("clamps progress at one hundred percent", () => {
    const progress = { downloaded: 300, total: 200, finished: false };
    expect(updateProgressPercent(progress)).toBe(100);
  });
});
