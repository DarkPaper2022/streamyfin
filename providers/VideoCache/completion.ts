/**
 * Download completion handling, LRU eviction, and the size budget for the
 * video cache. Owns the downloader event wiring: `recordComplete` is the
 * single place an index entry is born.
 */

import { EventEmitter } from "eventemitter3";
import { File } from "expo-file-system";
import type { EventSubscription } from "expo-modules-core";
import { VIDEO_CACHE_MAX_ENTRIES } from "@/constants/VideoCache";
import type {
  DownloadCompleteEvent as BGDownloadCompleteEvent,
  DownloadErrorEvent as BGDownloadErrorEvent,
} from "@/modules";
import { BackgroundDownloader } from "@/modules";
import { filePathToUri } from "@/providers/Downloads/utils";
import type { InFlightTask } from "./inflight";
import { getTask, removeTask } from "./inflight";
import { selectEntriesToEvict } from "./lru";
import { getCacheIndex, saveCacheIndex } from "./persistence";
import type { VideoCacheCompleteEvent, VideoCacheErrorEvent } from "./types";

// Default size budget in bytes; callers lower it via `applySizeBudget` when
// the user picks a smaller max cache size.
const DEFAULT_MAX_CACHE_SIZE_BYTES = 1024 * 1024 * 1024; // 1GB

let configuredMaxSizeBytes = DEFAULT_MAX_CACHE_SIZE_BYTES;

// Event listener subscriptions (for cleanup)
let _completeSubscription: EventSubscription | null = null;
let _errorSubscription: EventSubscription | null = null;
let listenersSetup = false;

class VideoCacheEventEmitter extends EventEmitter<{
  complete: (event: VideoCacheCompleteEvent) => void;
  error: (event: VideoCacheErrorEvent) => void;
}> {}

export const videoCacheEvents = new VideoCacheEventEmitter();

/**
 * Set up BackgroundDownloader event listeners. Idempotent: the first call
 * wires both events, later calls are no-ops.
 */
export function setupEventListeners(): void {
  if (listenersSetup) return;
  listenersSetup = true;

  try {
    _completeSubscription = BackgroundDownloader.addCompleteListener(
      (event: BGDownloadCompleteEvent) => {
        if (!getTask(event.taskId)) return; // Not a video-cache download
        void recordComplete(event.taskId, event.filePath);
      },
    );

    _errorSubscription = BackgroundDownloader.addErrorListener(
      (event: BGDownloadErrorEvent) => {
        const task = getTask(event.taskId);
        if (!task) return; // Not a video-cache download
        handleDownloadError(event, task);
      },
    );
  } catch (error) {
    console.warn("[VideoCache] Failed to setup event listeners:", error);
    listenersSetup = false;
  }
}

/**
 * Record a completed download: stat the file, write the index entry, evict
 * if over budget. The `complete` event fires only after the index is
 * consistent, so listeners can rely on `getForKey` hitting.
 */
export async function recordComplete(
  taskId: number,
  filePath: string,
): Promise<void> {
  // The native onComplete echoes back exactly what we enqueued: a bare
  // absolute path. Convert once to the file:// URI the index, the File
  // constructor, and the player all consume.
  const entryPath = filePathToUri(filePath);

  const task = getTask(taskId);
  if (!task) return; // Not a video-cache download (or already resolved)

  try {
    const file = new File(entryPath);
    if (!file.exists) {
      // The downloader reported success but the file is gone
      videoCacheEvents.emit("error", {
        streamKey: task.streamKey,
        itemId: task.itemId,
        error: "Completed download file is missing",
      });
      removeTask(taskId, task.streamKey);
      return;
    }

    const sizeBytes = file.info().size ?? 0;
    const index = getCacheIndex();

    index.entries[task.streamKey] = {
      streamKey: task.streamKey,
      itemId: task.itemId,
      mediaSourceId: task.mediaSourceId,
      url: task.url,
      path: entryPath,
      sizeBytes,
      storedAt: Date.now(),
      container: task.container,
      maxBitrate: task.maxBitrate,
      audioStreamIndex: task.audioStreamIndex,
      subtitleStreamIndex: task.subtitleStreamIndex,
    };
    index.totalSizeBytes += sizeBytes;
    saveCacheIndex(index);

    removeTask(taskId, task.streamKey);
    await evictIfNeeded();

    videoCacheEvents.emit("complete", {
      streamKey: task.streamKey,
      itemId: task.itemId,
      path: entryPath,
    });
  } catch (error) {
    console.error("[VideoCache] Error handling download complete:", error);
    removeTask(taskId, task.streamKey);
  }
}

/**
 * Set the size budget in megabytes (called when settings change) and evict
 * down to it. Awaits eviction so callers can rely on the resulting state.
 */
export async function applySizeBudget(maxSizeMB: number): Promise<void> {
  configuredMaxSizeBytes = maxSizeMB * 1024 * 1024;
  await evictIfNeeded();
}

/**
 * Test-only: reset the size budget override and re-arm the one-shot
 * listener setup so each spec starts from defaults.
 */
export function resetCompletionState(): void {
  configuredMaxSizeBytes = DEFAULT_MAX_CACHE_SIZE_BYTES;
  listenersSetup = false;
}

/** Evict oldest entries (by `storedAt`) until both limits fit. */
async function evictIfNeeded(): Promise<void> {
  const index = getCacheIndex();
  const victims = selectEntriesToEvict(Object.values(index.entries), {
    maxEntries: VIDEO_CACHE_MAX_ENTRIES,
    maxSizeBytes: configuredMaxSizeBytes,
  });

  for (const victim of victims) {
    console.log(
      `[VideoCache] Evicting ${victim.streamKey} ` +
        `(${(victim.sizeBytes / 1024 / 1024).toFixed(1)}MB)`,
    );
    try {
      const file = new File(victim.path);
      if (file.exists) {
        await file.delete();
      }
    } catch {
      // Ignore deletion errors; the index entry is dropped either way
    }
    index.totalSizeBytes -= victim.sizeBytes;
    delete index.entries[victim.streamKey];
  }

  if (victims.length > 0) {
    saveCacheIndex(index);
  }
}

/** Handle a download error: notify, then drop the in-flight marker. */
function handleDownloadError(
  event: BGDownloadErrorEvent,
  task: InFlightTask,
): void {
  console.error(
    `[VideoCache] Download failed for ${task.streamKey}:`,
    event.error,
  );
  videoCacheEvents.emit("error", {
    streamKey: task.streamKey,
    itemId: task.itemId,
    error: event.error,
  });
  removeTask(event.taskId, task.streamKey);
}
