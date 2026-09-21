import {
  afterAll,
  beforeEach,
  describe,
  expect,
  mock,
  setSystemTime,
  test,
} from "bun:test";

import { VIDEO_CACHE_INDEX_KEY } from "@/constants/VideoCache";
import {
  clearFakeFileSystem,
  Directory,
  deletePath,
  File,
  Paths,
  resetClock,
  stat,
  writeFile,
} from "@/test-utils/expoFileSystem";
import { clearMmkv, stubMmkv } from "@/test-utils/mmkv";
import { buildVideoStreamKey } from "./streamKey";
import type { VideoCacheEnqueueParams, VideoCacheIndex } from "./types";

// --- Module-boundary stubs (native modules can't load under bun:test) ---
mock.module("react-native-device-info", () => ({
  default: {
    getFreeDiskStorage: async () => 20 * 1024 * 1024 * 1024,
    getTotalDiskCapacity: async () => 128 * 1024 * 1024 * 1024,
  },
  getFreeDiskStorage: async () => 20 * 1024 * 1024 * 1024,
  getTotalDiskCapacity: async () => 128 * 1024 * 1024 * 1024,
}));

stubMmkv();
mock.module("expo-file-system", () => ({ Paths, Directory, File }));

// Fake background downloader: records enqueues and lets the test fire the
// native events the way the platform module would.
type EnqueuedDownload = {
  taskId: number;
  url: string;
  destinationPath?: string;
  headers?: Record<string, string>;
};
type CompleteEvent = { taskId: number; filePath: string; url: string };
type ErrorEvent = { taskId: number; error: string };

let nextTaskId = 1;
let completeListener: ((event: CompleteEvent) => void) | null = null;
let errorListener: ((event: ErrorEvent) => void) | null = null;
const enqueued: EnqueuedDownload[] = [];
const cancelledTaskIds: number[] = [];
// Failures the fake native side produced on its own (the strict boundary
// below), separate from errors the test fires manually.
const failedDownloads: Array<{
  taskId: number;
  destinationPath?: string;
  error: string;
}> = [];

// The strict native boundary: OkHttpDownloadManager does File(destinationPath)
// in Java, so a destination that is not a bare absolute path — missing the
// leading `/`, or carrying a `file:` scheme — can never be written. The real
// module reports that as an async ENOENT after the enqueue resolved, and the
// download never completes. The mock models exactly that.
const isBareAbsolutePath = (destinationPath?: string): boolean => {
  if (destinationPath === undefined) return false;
  return destinationPath.startsWith("/") && !destinationPath.includes("file:");
};

mock.module("@/modules", () => ({
  BackgroundDownloader: {
    enqueueDownload: async (
      url: string,
      destinationPath?: string,
      _metadata?: unknown,
      headers?: Record<string, string>,
    ) => {
      const taskId = nextTaskId;
      nextTaskId += 1;
      enqueued.push({ taskId, url, destinationPath, headers });
      if (!isBareAbsolutePath(destinationPath)) {
        const error = `${destinationPath}: open failed: ENOENT (No such file or directory)`;
        queueMicrotask(() => {
          failedDownloads.push({ taskId, destinationPath, error });
          errorListener?.({ taskId, error });
        });
      }
      return taskId;
    },
    cancelDownload: (taskId: number) => {
      cancelledTaskIds.push(taskId);
    },
    addCompleteListener: (listener: (event: CompleteEvent) => void) => {
      completeListener = listener;
      return { remove() {} };
    },
    addErrorListener: (listener: (event: ErrorEvent) => void) => {
      errorListener = listener;
      return { remove() {} };
    },
  },
}));

const BASE_NOW = 1_760_000_000_000;

const videoCache = await import("./index");
const { storage } = await import("@/utils/mmkv");

beforeEach(() => {
  setSystemTime(BASE_NOW);
  resetClock();
  clearFakeFileSystem();
  clearMmkv();
  nextTaskId = 1;
  completeListener = null;
  errorListener = null;
  enqueued.length = 0;
  cancelledTaskIds.length = 0;
  failedDownloads.length = 0;
  videoCache.resetVideoCacheState();
});

afterAll(() => {
  // Restore the real clock so other spec files are not time-warped.
  setSystemTime();
});

const directParams = (
  itemId: string,
  patch: Partial<VideoCacheEnqueueParams> = {},
): VideoCacheEnqueueParams => ({
  itemId,
  mediaSourceId: "ms-1",
  url: `https://server.local/Videos/${itemId}/stream.mkv`,
  container: "mkv",
  ...patch,
});

/**
 * Simulates the native downloader finishing `enqueued[index]`: writes the
 * file at the destination, fires the complete event, and waits for the
 * module's own `complete` emission — which fires only after the index is
 * persisted and eviction has settled.
 */
const completeDownload = async (
  index: number,
  content: string,
): Promise<void> => {
  const task = enqueued[index];
  if (!task?.destinationPath) {
    throw new Error(`expected an enqueued download at index ${index}`);
  }
  writeFile(task.destinationPath, content);
  if (!completeListener) {
    throw new Error("expected a registered complete listener");
  }
  completeListener({
    taskId: task.taskId,
    filePath: task.destinationPath,
    url: task.url,
  });
  await new Promise<void>((resolve) => {
    videoCache.videoCacheEvents.once("complete", () => resolve());
  });
};

describe("B1: enqueue + complete", () => {
  test("writes an index entry with size and path; getForKey hits", async () => {
    const params = directParams("a4076c60977cd217655224e2f0e52690", {
      maxBitrate: 1_500_000,
      audioStreamIndex: 0,
      subtitleStreamIndex: 2,
    });
    await videoCache.enqueueStream(params);

    const key = buildVideoStreamKey(params);
    expect(enqueued).toHaveLength(1);
    expect(videoCache.isCaching(key)).toBe(true);

    const destination = enqueued[0]?.destinationPath;
    if (!destination) throw new Error("expected a destination path");

    const content = "v".repeat(4096);
    await completeDownload(0, content);

    expect(videoCache.isCaching(key)).toBe(false);

    const hit = videoCache.getForKey(key);
    if (!hit) throw new Error("expected a cache hit after completion");
    expect(hit).toEqual({
      streamKey: key,
      itemId: params.itemId,
      mediaSourceId: "ms-1",
      url: params.url,
      // The index stores the file:// URI, not the bare destination
      path: `file://${destination}`,
      sizeBytes: 4096,
      storedAt: BASE_NOW,
      container: "mkv",
      maxBitrate: 1_500_000,
      audioStreamIndex: 0,
      subtitleStreamIndex: 2,
    });
    expect(stat(destination)).not.toBeNull();

    // The entry is persisted, not just held in memory
    const persisted = JSON.parse(
      storage.getString(VIDEO_CACHE_INDEX_KEY) ?? "{}",
    ) as VideoCacheIndex;
    expect(persisted.entries[key]?.sizeBytes).toBe(4096);
  });

  test("forwards proxy headers to the downloader", async () => {
    const headers = {
      Authorization: 'MediaBrowser DeviceId="device-1", Token="SECRET_TOKEN"',
    };
    await videoCache.enqueueStream(directParams("item-h", { headers }));
    expect(enqueued[0]?.headers).toEqual(headers);
  });

  test("skips enqueue when the stream is already cached", async () => {
    const params = directParams("item-s");
    await videoCache.enqueueStream(params);
    await completeDownload(0, "payload");
    await videoCache.enqueueStream(params);
    expect(enqueued).toHaveLength(1);
  });

  test("skips enqueue when the stream is already in flight", async () => {
    const params = directParams("item-f");
    await videoCache.enqueueStream(params);
    await videoCache.enqueueStream(params);
    expect(enqueued).toHaveLength(1);
  });

  test("a failed download clears the in-flight marker and emits an error", async () => {
    const params = directParams("item-e");
    await videoCache.enqueueStream(params);
    const key = buildVideoStreamKey(params);
    expect(videoCache.isCaching(key)).toBe(true);

    const error = new Promise<string>((resolve) => {
      videoCache.videoCacheEvents.once("error", (event) =>
        resolve(event.error),
      );
    });
    if (!errorListener) throw new Error("expected a registered error listener");
    errorListener({ taskId: enqueued[0]?.taskId ?? -1, error: "boom" });

    expect(await error).toBe("boom");
    expect(videoCache.isCaching(key)).toBe(false);
  });
});

describe("regression: native path contract (device boundaries)", () => {
  test("enqueues a bare absolute destination for the native downloader", async () => {
    const params = directParams("item-dest");
    await videoCache.enqueueStream(params);

    const destination = enqueued[0]?.destinationPath;
    if (!destination) throw new Error("expected a destination path");
    // The native OkHttpDownloadManager does File(destinationPath): it must be
    // a bare absolute path, never a file: URI (a scheme is a relative first
    // path component under cwd and every download died with ENOENT).
    expect(destination.startsWith("/")).toBe(true);
    expect(destination).not.toContain("file:");
    expect(destination).not.toContain("//");
    expect(destination).toContain("streamyfin-video-cache/");
  });

  test("stores a file:// URI in the index entry and the complete event", async () => {
    const params = directParams("item-uri");
    await videoCache.enqueueStream(params);
    const destination = enqueued[0]?.destinationPath;
    if (!destination) throw new Error("expected a destination path");

    const emitted = new Promise<string>((resolve) => {
      videoCache.videoCacheEvents.once("complete", (event) =>
        resolve(event.path),
      );
    });
    await completeDownload(0, "payload");

    const entryPath = `file://${destination}`;
    expect(await emitted).toBe(entryPath);

    const key = buildVideoStreamKey(params);
    const persisted = JSON.parse(
      storage.getString(VIDEO_CACHE_INDEX_KEY) ?? "{}",
    ) as VideoCacheIndex;
    expect(persisted.entries[key]?.path).toBe(entryPath);
    expect(persisted.entries[key]?.path?.startsWith("file://")).toBe(true);

    const hit = videoCache.getForKey(key);
    if (!hit) throw new Error("expected a cache hit after completion");
    expect(hit.path).toBe(entryPath);
  });

  test("native boundary: a file:-schemed destination fails with ENOENT, never completes", async () => {
    const { BackgroundDownloader } = await import("@/modules");
    const taskId = await BackgroundDownloader.enqueueDownload(
      "https://server.local/Videos/item-legacy/stream.mkv",
      // The pre-fix shape: a URI, not a path
      "file:/cache/streamyfin-video-cache/legacy.mkv",
    );
    // The enqueue itself resolves; the Java File() failure arrives async,
    // the way the OkHttp callback reports it on device.
    expect(taskId).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(failedDownloads).toHaveLength(1);
    expect(failedDownloads[0]?.destinationPath).toBe(
      "file:/cache/streamyfin-video-cache/legacy.mkv",
    );
    expect(failedDownloads[0]?.error).toContain("ENOENT");
    expect(enqueued).toHaveLength(1);
  });

  test("re-creates the cache directory when it was deleted under a live process", async () => {
    const first = directParams("item-stale-1");
    await videoCache.enqueueStream(first);
    const dir = new Directory(Paths.cache, "streamyfin-video-cache");
    expect(dir.exists).toBe(true);

    // The OS reclaims the soft cache directory while the process is alive;
    // the module's cached Directory reference is now stale.
    dir.delete();
    expect(dir.exists).toBe(false);

    let error: string | null = null;
    videoCache.videoCacheEvents.once("error", (event) => {
      error = event.error;
    });

    const second = directParams("item-stale-2");
    await videoCache.enqueueStream(second);
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The directory was re-created and the download enqueued with a bare path
    expect(new Directory(Paths.cache, "streamyfin-video-cache").exists).toBe(
      true,
    );
    expect(enqueued).toHaveLength(2);
    const destination = enqueued[1]?.destinationPath;
    if (!destination) throw new Error("expected a second enqueued download");
    expect(destination.startsWith("/")).toBe(true);
    expect(destination).not.toContain("file:");
    expect(error).toBeNull();

    // And the recovered download completes into the re-created directory
    await completeDownload(1, "recovered");
    expect(videoCache.getForKey(buildVideoStreamKey(second))?.path).toBe(
      `file://${destination}`,
    );
  });

  test("the fake models java.io.File(URI): literal write, decoded lookup", () => {
    // The native writer is Java File(String): a percent-escaped name lands
    // on disk verbatim.
    writeFile("/cache/streamyfin-video-cache/v1%7Ci%3Dx.mkv", "encoded");
    // The expo File API is java.io.File(URI): URI.getPath() decodes, so a
    // File for the escaped URI probes the DECODED name and must not see the
    // literal record (the device B8-hit bug).
    expect(
      new File("file:///cache/streamyfin-video-cache/v1%7Ci%3Dx.mkv").exists,
    ).toBe(false);
    // A URI-safe (decode-invariant) name round-trips through the same model.
    writeFile("/cache/streamyfin-video-cache/v1_i_x.mkv", "safe");
    expect(
      new File("file:///cache/streamyfin-video-cache/v1_i_x.mkv").exists,
    ).toBe(true);
    expect(new File("/cache/streamyfin-video-cache/v1_i_x.mkv").exists).toBe(
      true,
    );
  });

  test("the stored filename survives the URI round-trip (java.io.File(URI) decodes)", async () => {
    const params = directParams("item-roundtrip");
    await videoCache.enqueueStream(params);
    await completeDownload(0, "payload");

    const key = buildVideoStreamKey(params);
    const persisted = JSON.parse(
      storage.getString(VIDEO_CACHE_INDEX_KEY) ?? "{}",
    ) as VideoCacheIndex;
    const entry = persisted.entries[key];
    if (!entry) throw new Error("expected an index entry after completion");

    // The on-disk basename must carry no percent escapes: java.io.File(URI)
    // decodes them in getPath(), which would probe a file that was never
    // written (no index, no hit, ever).
    const basename = entry.path.slice(entry.path.lastIndexOf("/") + 1);
    expect(basename).not.toMatch(/%[0-9A-F]{2}/i);

    // And the stat inside getForKey matched the on-disk file through the
    // decoding model: the entry resolves as a hit.
    const hit = videoCache.getForKey(key);
    if (!hit) throw new Error("expected the entry to hit through the URI stat");
    expect(hit.path).toBe(entry.path);
  });

  test("eviction deletes the actual file", async () => {
    const first = directParams("item-evict-1");
    const second = directParams("item-evict-2");
    await videoCache.enqueueStream(first);
    setSystemTime(BASE_NOW + 1000);
    await videoCache.enqueueStream(second);
    await completeDownload(0, "x".repeat(600_000));
    await completeDownload(1, "x".repeat(600_000));

    const key1 = buildVideoStreamKey(first);
    const entry1 = videoCache.getForKey(key1);
    if (!entry1) throw new Error("expected the first entry to exist");
    expect(stat(entry1.path)).not.toBeNull();

    // 1.2MB against a 1MB budget: the oldest entry is evicted
    await videoCache.reserveSpace(1);

    // Index entry AND the on-disk file are gone — eviction stats and deletes
    // through the File(URI) boundary, so an escaped name would leak here
    expect(videoCache.getForKey(key1)).toBeNull();
    expect(stat(entry1.path)).toBeNull();

    const entry2 = videoCache.getForKey(buildVideoStreamKey(second));
    if (!entry2) throw new Error("expected the newer entry to survive");
    expect(stat(entry2.path)).not.toBeNull();
  });
});

describe("B2: LRU eviction", () => {
  test("inserting the 21st entry evicts the oldest-storedAt entry and its file", async () => {
    const keys: string[] = [];
    for (let i = 1; i <= 21; i += 1) {
      setSystemTime(BASE_NOW + i * 1000);
      const params = directParams(`item-${i}`);
      await videoCache.enqueueStream(params);
      await completeDownload(i - 1, `content-${i}`);
      keys.push(buildVideoStreamKey(params));
    }

    // The oldest entry (item-1) is gone: index and file
    expect(videoCache.getForKey(keys[0])).toBeNull();
    expect(stat(enqueued[0].destinationPath ?? "")).toBeNull();
    // The 20 newest entries survive
    for (let i = 1; i <= 20; i += 1) {
      expect(videoCache.getForKey(keys[i])).not.toBeNull();
    }
  });
});

describe("B3: lazy stale cleanup", () => {
  test("drops an index entry whose file the OS evicted, on the next access", async () => {
    const params = directParams("item-3");
    await videoCache.enqueueStream(params);
    await completeDownload(0, "payload");

    const key = buildVideoStreamKey(params);
    const entry = videoCache.getForKey(key);
    if (!entry) throw new Error("expected a cache hit before eviction");
    expect(stat(entry.path)).not.toBeNull();

    // The OS reclaims the soft cache directory
    deletePath(entry.path);

    // Next access drops the stale entry and misses — no crash, no scan
    expect(videoCache.getForKey(key)).toBeNull();
    const persisted = JSON.parse(
      storage.getString(VIDEO_CACHE_INDEX_KEY) ?? "{}",
    ) as VideoCacheIndex;
    expect(persisted.entries[key]).toBeUndefined();
    // And it stays dropped
    expect(videoCache.getForKey(key)).toBeNull();
  });
});

describe("B4: skip rules", () => {
  test("only a direct stream without a transcoding URL is cacheable", () => {
    expect(
      videoCache.shouldCacheStream({
        DirectStreamUrl: "https://server.local/Videos/item/stream.mkv",
      }),
    ).toBe(true);
    expect(
      videoCache.shouldCacheStream({
        TranscodingUrl: "https://server.local/Videos/item/stream.ts",
      }),
    ).toBe(false);
    // Both present: the transcode is what would play, so skip
    expect(
      videoCache.shouldCacheStream({
        DirectStreamUrl: "https://server.local/Videos/item/stream.mkv",
        TranscodingUrl: "https://server.local/Videos/item/stream.ts",
      }),
    ).toBe(false);
    // Neither: nothing to cache
    expect(videoCache.shouldCacheStream({})).toBe(false);
  });
});

describe("B5: key mismatch", () => {
  test("getForKey with a different stream key misses", async () => {
    const params = directParams("item-5");
    await videoCache.enqueueStream(params);
    await completeDownload(0, "payload");

    const rightKey = buildVideoStreamKey(params);
    const wrongKey = buildVideoStreamKey({
      ...params,
      maxBitrate: 999_999_999,
    });
    expect(videoCache.getForKey(rightKey)).not.toBeNull();
    expect(videoCache.getForKey(wrongKey)).toBeNull();
  });
});

describe("B7: disable path", () => {
  test("cancelAll cancels every in-flight download but keeps completed entries and files", async () => {
    const a = directParams("item-a");
    const b = directParams("item-b");
    const c = directParams("item-c");
    await videoCache.enqueueStream(a);
    await videoCache.enqueueStream(b);
    await videoCache.enqueueStream(c);
    expect(enqueued).toHaveLength(3);

    // a completes; b and c are still in flight
    await completeDownload(0, "a-payload");

    cancelledTaskIds.length = 0;
    videoCache.cancelAll();

    expect(cancelledTaskIds).toEqual([enqueued[1].taskId, enqueued[2].taskId]);
    expect(videoCache.isCaching(buildVideoStreamKey(a))).toBe(false);
    expect(videoCache.isCaching(buildVideoStreamKey(b))).toBe(false);
    expect(videoCache.isCaching(buildVideoStreamKey(c))).toBe(false);

    // The completed entry and its file are untouched
    const entryA = videoCache.getForKey(buildVideoStreamKey(a));
    if (!entryA) throw new Error("expected the completed entry to survive");
    expect(stat(entryA.path)).not.toBeNull();
  });

  test("cancelForKey cancels only the matching in-flight download", async () => {
    const a = directParams("item-ka");
    const b = directParams("item-kb");
    await videoCache.enqueueStream(a);
    await videoCache.enqueueStream(b);

    cancelledTaskIds.length = 0;
    videoCache.cancelForKey(buildVideoStreamKey(a));

    expect(cancelledTaskIds).toEqual([enqueued[0].taskId]);
    expect(videoCache.isCaching(buildVideoStreamKey(a))).toBe(false);
    expect(videoCache.isCaching(buildVideoStreamKey(b))).toBe(true);
  });
});

describe("reserveSpace", () => {
  test("evicts oldest entries down to the size budget", async () => {
    const big = "x".repeat(1_500_000); // 1.5MB each
    const first = directParams("big-1");
    const second = directParams("big-2");
    await videoCache.enqueueStream(first);
    setSystemTime(BASE_NOW + 1000);
    await videoCache.enqueueStream(second);
    await completeDownload(0, big);
    await completeDownload(1, big);

    const key1 = buildVideoStreamKey(first);
    const key2 = buildVideoStreamKey(second);
    expect(videoCache.getForKey(key1)).not.toBeNull();
    expect(videoCache.getForKey(key2)).not.toBeNull();

    // 3MB of cache against a 1MB budget: both entries must go
    await videoCache.reserveSpace(1);

    expect(videoCache.getForKey(key1)).toBeNull();
    expect(videoCache.getForKey(key2)).toBeNull();
  });
});
