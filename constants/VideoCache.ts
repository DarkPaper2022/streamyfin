/**
 * Video lookahead cache policy constants.
 *
 * The cache is soft: it lives under the OS-evictable cache directory and an
 * entry whose file the OS reclaims is dropped lazily on the next access
 * (there is deliberately no startup scan).
 */

/**
 * Name of the cache directory under `Paths.cache`. The OS may delete its
 * contents at any time under storage pressure; stale index entries are
 * cleaned up lazily when they are next touched.
 */
export const VIDEO_CACHE_DIR_NAME = "streamyfin-video-cache";

/**
 * MMKV key holding the JSON-serialized cache index. The `v1` suffix lets a
 * future schema change start from a fresh key instead of migrating.
 */
export const VIDEO_CACHE_INDEX_KEY = "video_cache.v1.json";

/**
 * At most one lookahead download in flight at a time. The current playback
 * keeps bandwidth priority; the native downloader serializes queued
 * downloads behind it.
 */
export const VIDEO_CACHE_MAX_CONCURRENT = 1;

/**
 * Upper bound on cached streams, evicted LRU by `storedAt`. An episode is a
 * few hundred MB at typical bitrates, so 20 entries stays within the
 * default size budget while covering several episodes ahead.
 */
export const VIDEO_CACHE_MAX_ENTRIES = 20;

/**
 * Minimum free disk space threshold (5 GB). When device free disk storage
 * drops below this threshold, eviction will trim older cache entries until
 * free disk space is safely above the threshold.
 */
export const VIDEO_CACHE_MIN_FREE_DISK_BYTES = 5 * 1024 * 1024 * 1024; // 5 GB

/**
 * Magic value for videoMaxCacheSizeMB meaning "Auto / Unlimited by size",
 * where cache retention is guided purely by available disk space (retaining
 * at least VIDEO_CACHE_MIN_FREE_DISK_BYTES) and entry count limits.
 */
export const VIDEO_CACHE_SIZE_UNLIMITED = 0;
