import { describe, expect, test } from "bun:test";

import {
  VIDEO_CACHE_DIR_NAME,
  VIDEO_CACHE_INDEX_KEY,
  VIDEO_CACHE_MAX_CONCURRENT,
  VIDEO_CACHE_MAX_ENTRIES,
} from "./VideoCache";

describe("VideoCache constants", () => {
  test("pins the cache directory name and index key", () => {
    // The dir lives under the OS-evictable cache root, and the index key is
    // versioned so a schema change can start fresh instead of migrating.
    expect(VIDEO_CACHE_DIR_NAME).toBe("streamyfin-video-cache");
    expect(VIDEO_CACHE_INDEX_KEY).toBe("video_cache.v1.json");
  });

  test("pins the download and eviction policy", () => {
    // One download in flight at a time: playback keeps bandwidth priority.
    expect(VIDEO_CACHE_MAX_CONCURRENT).toBe(1);
    // LRU cap by storedAt.
    expect(VIDEO_CACHE_MAX_ENTRIES).toBe(20);
  });
});
