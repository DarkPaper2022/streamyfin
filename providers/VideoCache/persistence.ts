/**
 * Index persistence and cache directory for the video cache.
 *
 * The index is tiny (≤ `VIDEO_CACHE_MAX_ENTRIES` entries), so every
 * operation reads it fresh from MMKV instead of keeping a second in-memory
 * copy — the store is the single source of truth.
 */

import { Directory, Paths } from "expo-file-system";
import {
  VIDEO_CACHE_DIR_NAME,
  VIDEO_CACHE_INDEX_KEY,
} from "@/constants/VideoCache";
import { storage } from "@/utils/mmkv";
import type { VideoCacheIndex } from "./types";

let cacheDir: Directory | null = null;

export const emptyIndex = (): VideoCacheIndex => ({
  entries: {},
  totalSizeBytes: 0,
});

/** Read the index; a corrupt or absent index yields a fresh empty one. */
export const getCacheIndex = (): VideoCacheIndex => {
  try {
    const data = storage.getString(VIDEO_CACHE_INDEX_KEY);
    if (data) {
      return JSON.parse(data) as VideoCacheIndex;
    }
  } catch {
    // Corrupt index: start fresh; the cache is soft and self-healing
  }
  return emptyIndex();
};

/** Persist the index. */
export const saveCacheIndex = (index: VideoCacheIndex): void => {
  try {
    storage.set(VIDEO_CACHE_INDEX_KEY, JSON.stringify(index));
  } catch {
    // Ignore save errors; the cache is soft and self-healing
  }
};

/**
 * Ensure the cache directory exists under `Paths.cache` (the OS-evictable
 * root — never `Paths.document`). The cached reference is re-checked on
 * every call: the OS may reclaim the directory out from under a live
 * process, in which case a stale `Directory` reference is dropped and the
 * directory re-created. Returns `null` when it cannot be created.
 */
export const ensureCacheDir = async (): Promise<Directory | null> => {
  if (!cacheDir?.exists) {
    try {
      cacheDir = new Directory(Paths.cache, VIDEO_CACHE_DIR_NAME);
      if (!cacheDir.exists) {
        await cacheDir.create();
      }
    } catch (error) {
      console.warn("[VideoCache] Failed to create cache directory:", error);
      return null;
    }
  }
  return cacheDir;
};

/** Test-only: drop the cached directory reference so specs re-create it. */
export const resetCacheDir = (): void => {
  cacheDir = null;
};
