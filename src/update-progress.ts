import type { DownloadEvent } from "@tauri-apps/plugin-updater";

export type UpdateDownloadProgress = {
  downloaded: number;
  total: number | null;
  finished: boolean;
};

export const emptyUpdateProgress: UpdateDownloadProgress = {
  downloaded: 0,
  total: null,
  finished: false,
};

export function advanceUpdateProgress(
  current: UpdateDownloadProgress,
  event: DownloadEvent,
): UpdateDownloadProgress {
  if (event.event === "Started") {
    const total = event.data.contentLength;
    return { downloaded: 0, total: total && total > 0 ? total : null, finished: false };
  }
  if (event.event === "Progress") {
    return { ...current, downloaded: current.downloaded + Math.max(0, event.data.chunkLength) };
  }
  return { ...current, finished: true };
}

export function updateProgressPercent(progress: UpdateDownloadProgress): number | null {
  if (!progress.total) return null;
  return Math.min(100, Math.round((progress.downloaded / progress.total) * 100));
}

export function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
