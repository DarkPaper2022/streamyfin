/**
 * Video Cache Module
 *
 * Soft lookahead cache for direct video streams:
 * - Serial downloads (playback keeps bandwidth priority) into the
 *   OS-evictable `Paths.cache` directory
 * - One index entry per stream key, persisted as JSON in MMKV
 * - LRU eviction by `storedAt` (entry count + size budget)
 * - Lazy stale cleanup: an entry whose file the OS evicted is dropped on
 *   the next access. There is deliberately no startup scan of the cache
 *   directory.
 * - Cancelling (feature disabled) removes in-flight downloads but keeps
 *   completed files: the cache stays warm if the setting re-enables.
 *
 * Mirrors the shape of `providers/AudioStorage`: a module-level singleton
 * behind exported functions.
 */

import { File } from "expo-file-system";
import { BackgroundDownloader } from "@/modules";
import {
  applySizeBudget,
  resetCompletionState,
  setupEventListeners,
} from "./completion";
import {
  cancelInFlightTasks,
  clearInFlight,
  isCaching,
  markStart,
  removeTask,
  trackTask,
} from "./inflight";
import {
  ensureCacheDir,
  getCacheIndex,
  resetCacheDir,
  saveCacheIndex,
} from "./persistence";
import { buildVideoStreamKey } from "./streamKey";
import type {
  VideoCacheEnqueueParams,
  VideoCacheEntry,
  VideoStreamSource,
} from "./types";

export { recordComplete, videoCacheEvents } from "./completion";
/** Re-exported so the cache API has a single import surface. */
export { isCaching, markStart } from "./inflight";

/**
 * Decide whether a media source is worth caching. Only direct streams are
 * cacheable: a transcoding URL streams a container that cannot be stored as
 * one file, so any source exposing `TranscodingUrl` is skipped even when it
 * also has a direct URL.
 */
export function shouldCacheStream(source: VideoStreamSource): boolean {
  return !source.TranscodingUrl && Boolean(source.DirectStreamUrl);
}

/**
 * Initialize the video cache - call this on app startup. Creates the
 * directory, warms the index, and wires the downloader events. Does not
 * scan the cache directory: stale entries are cleaned up lazily.
 */
export async function initVideoCache(): Promise<void> {
  await ensureCacheDir();
  getCacheIndex();
  setupEventListeners();
}

/**
 * Enqueue a direct stream for the lookahead cache. Skips silently when the
 * stream is already cached or in flight. The native downloader serializes
 * the queue, so playback keeps bandwidth priority.
 */
export async function enqueueStream(
  params: VideoCacheEnqueueParams,
): Promise<void> {
  const streamKey = buildVideoStreamKey(params);

  if (isCaching(streamKey) || getForKey(streamKey)) {
    return;
  }

  setupEventListeners();
  const dir = await ensureCacheDir();
  if (!dir) {
    console.warn("[VideoCache] Cache directory unavailable; skipping");
    return;
  }

  const extension = params.container?.toLowerCase() || "mp4";
  // The name is deterministic (the key is), so the same rendition always
  // maps to the same file (re-enqueue is idempotent). It must also survive
  // a java.net.URI round-trip: on Android the expo File API is
  // java.io.File(URI), whose getPath() percent-decodes, so any escaped
  // character in the name would make the file unstat-able. The key charset
  // is [a-z0-9|=.-]; the index (not the name) is the mapping, so the name
  // only needs to be deterministic and URI-safe.
  const fileName = `${streamKey.replace(/[^A-Za-z0-9.-]/g, "_")}.${extension}`;
  // The native downloader's Java File() needs a bare absolute path: a
  // `file:` scheme is treated as a relative first path component and every
  // download dies with ENOENT. Directory.uri carries the scheme in the
  // platform's slash shape (`file:/` single-slash on Android, `file:///`
  // elsewhere), so strip the scheme — and the authority slashes when present
  // — keeping the path's own root slash. The index entry stores the file://
  // URI form instead (see completion.ts).
  const path = `${dir.uri.replace(/^file:(\/\/)?/, "")}/${fileName}`;

  markStart(streamKey);
  try {
    const taskId = await BackgroundDownloader.enqueueDownload(
      params.url,
      path,
      undefined,
      params.headers,
    );
    trackTask(taskId, { ...params, streamKey, path });
  } catch (error) {
    console.error("[VideoCache] Failed to enqueue download:", error);
    // No task id exists; drop the key if no other task references it.
    removeTask(-1, streamKey);
  }
}

/**
 * Hit check for a cached stream: an index entry exists AND the file is
 * still on disk (verified via stat).
 *
 * Lazy stale cleanup: when the entry exists but the file is gone (the OS
 * evicted the soft cache), the entry is dropped, the index persisted, and
 * `null` returned.
 */
export function getForKey(streamKey: string): VideoCacheEntry | null {
  const index = getCacheIndex();
  const entry = index.entries[streamKey];
  if (!entry) return null;

  try {
    if (new File(entry.path).exists) {
      return entry;
    }
  } catch {
    // Fall through to stale cleanup
  }

  console.log(`[VideoCache] Dropping stale entry: ${streamKey}`);
  index.totalSizeBytes -= entry.sizeBytes;
  delete index.entries[streamKey];
  saveCacheIndex(index);
  return null;
}

/**
 * Set the size budget in megabytes (called when settings change) and evict
 * down to it. Awaits eviction so callers can rely on the resulting state.
 */
export async function reserveSpace(maxSizeMB: number): Promise<void> {
  await applySizeBudget(maxSizeMB);
}

/**
 * Cancel the in-flight download for one stream. Completed entries and
 * their files are untouched.
 */
export function cancelForKey(streamKey: string): void {
  cancelInFlightTasks(cancelWithGuard, (task) => task.streamKey === streamKey);
}

/**
 * Cancel every in-flight download (used when the lookahead setting is
 * turned off). Completed entries and their files are left in place: the
 * cache stays warm if the setting is re-enabled.
 */
export function cancelAll(): void {
  cancelInFlightTasks(cancelWithGuard);
}

/**
 * Test-only: drop all in-flight tracking, the cached directory reference,
 * the one-shot event listener setup, and any size budget override so each
 * spec starts from defaults.
 */
export function resetVideoCacheState(): void {
  clearInFlight();
  resetCacheDir();
  resetCompletionState();
}

/** Cancel via the downloader, ignoring platform errors. */
function cancelWithGuard(taskId: number): void {
  try {
    BackgroundDownloader.cancelDownload(taskId);
  } catch {
    // Ignore cancel errors
  }
}
