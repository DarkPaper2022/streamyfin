import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { BaseItemDto } from "@jellyfin/sdk/lib/generated-client";
import { atom } from "jotai";
import { VIDEO_CACHE_INDEX_KEY } from "@/constants/VideoCache";
import {
  clearFakeFileSystem,
  Directory,
  File,
  Paths,
  writeFile,
} from "@/test-utils/expoFileSystem";
import { makeApi } from "@/test-utils/jellyfinApi";
import { clearMmkv, stubMmkv } from "@/test-utils/mmkv";
import { stubReactNative } from "@/test-utils/reactNative";
import type { Settings } from "@/utils/atoms/settings";

// The hook is tested against the REAL VideoCache module and the REAL
// getStreamUrl: only the native leaves are stubbed, mirroring
// providers/VideoCache/index.test.ts and utils/jellyfin/media/getStreamUrl.test.ts
// (stream resolution is faked at the wire with makeApi, not by mocking the
// module — mock.module is global and re-stubbing per spec is the repo rule).
//
// Android TV on purpose: this spec's chain instantiates utils/atoms/settings
// early (the hook imports getActivePlayerType), and settings.ts freezes its
// platform capability consts (isNativePlayerSupported*) at module evaluation.
// Whichever spec wins that race pins the consts for the whole run, so the
// stub must be the platform utils/atoms/settings.test.ts asserts against.
// The hook's own behavior under test is platform-independent.
stubReactNative({ OS: "android", isTV: true });
stubMmkv();
mock.module("expo", () => ({
  // The getStreamUrl -> device-profile chain probes the native MPV module;
  // under bun:test there is none.
  requireOptionalNativeModule: () => null,
}));
mock.module("expo-file-system", () => ({ Paths, Directory, File }));
// The settings chain (utils/atoms/settings) pulls modules that need native
// backends or React rendering; the hook only reads the settings TYPE and
// getActivePlayerType, so mirrors of the real export surface suffice.
// (Same set as utils/atoms/settings.holdToSpeed.test.ts.)
mock.module("expo-secure-store", () => ({
  getItem: () => null,
  setItem: () => undefined,
  getItemAsync: async () => null,
  setItemAsync: async () => undefined,
  deleteItemAsync: async () => undefined,
}));
mock.module("expo-crypto", () => ({
  CryptoDigestAlgorithm: { SHA256: "SHA256" },
  digestStringAsync: async () => "sha256-digest",
}));
// BitrateSelector is a React component module; only the BITRATES table matters.
mock.module("@/components/BitrateSelector", () => ({
  BITRATES: [{ key: "Max", value: undefined }],
}));
// JellyfinProvider drags in react-native-device-info (native at test time);
// settings.ts only reads its atoms.
mock.module("@/providers/JellyfinProvider", () => ({
  apiAtom: atom(null),
  userAtom: atom(null),
}));
// The TV-safe wrapper requires expo-screen-orientation on non-TV platforms,
// which bun:test cannot load.
mock.module("@/packages/expo-screen-orientation", () => ({
  OrientationLock: {
    DEFAULT: 0,
    ALL: 1,
    PORTRAIT: 2,
    PORTRAIT_UP: 3,
    PORTRAIT_DOWN: 4,
    LANDSCAPE: 5,
    LANDSCAPE_LEFT: 6,
    LANDSCAPE_RIGHT: 7,
    OTHER: 8,
    UNKNOWN: 9,
  },
}));
// Full surface: mock.module re-links every importer, and a missing export
// breaks whichever OTHER spec's module links after this file.
mock.module("@/utils/log", () => ({
  writeToLog: () => undefined,
  logAndCaptureError: () => undefined,
  writeInfoLog: () => undefined,
  writeErrorLog: () => undefined,
  writeDebugLog: () => undefined,
  readFromLog: () => [],
  useLog: () => ({ logs: [], clearLogs: () => undefined }),
  LogProvider: ({ children }: { children: unknown }) => children,
  default: atom([]),
}));

// Fake background downloader: records enqueues/cancels and lets the test fire
// the native events the way the platform module would.
type EnqueuedDownload = {
  taskId: number;
  url: string;
  destinationPath?: string;
  headers?: Record<string, string>;
};
type CompleteEvent = { taskId: number; filePath: string; url: string };

let nextTaskId = 1;
let completeListener: ((event: CompleteEvent) => void) | null = null;
const enqueued: EnqueuedDownload[] = [];
const cancelledTaskIds: number[] = [];

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
      return taskId;
    },
    cancelDownload: (taskId: number) => {
      cancelledTaskIds.push(taskId);
    },
    addCompleteListener: (listener: (event: CompleteEvent) => void) => {
      completeListener = listener;
      return { remove() {} };
    },
    addErrorListener: () => ({ remove() {} }),
  },
}));

// --- React hook harness: bun:test cannot load react in a render context and
// the repo has no renderer, so the hook's useRef/useEffect calls are routed
// through a per-render harness that supports re-renders (settings flips).
// mock.module is global and re-links every importer, so the factory spreads
// the real module: specs that load later (jotai) must still see the full
// react surface.
const realReact = await import("react");

type EffectFn = () => undefined | (() => void);

interface EffectSlot {
  fn: EffectFn;
  deps: readonly unknown[] | undefined;
  prevDeps: readonly unknown[] | undefined;
  cleanup: (() => void) | undefined;
}

interface Harness {
  refs: Array<{ current: unknown }>;
  effects: Array<EffectSlot | undefined>;
  position: number;
}

let activeHarness: Harness | null = null;

mock.module("react", () => ({
  ...realReact,
  useRef: (initial: unknown) => {
    const h = activeHarness;
    if (!h) throw new Error("hook ran outside renderHook");
    const position = h.position;
    h.position += 1;
    if (h.refs[position] === undefined) {
      h.refs[position] = { current: initial };
    }
    return h.refs[position];
  },
  useEffect: (fn: EffectFn, deps: readonly unknown[] | undefined) => {
    const h = activeHarness;
    if (!h) throw new Error("hook ran outside renderHook");
    const position = h.position;
    h.position += 1;
    h.effects[position] = {
      fn,
      deps,
      prevDeps: h.effects[position]?.prevDeps,
      cleanup: h.effects[position]?.cleanup,
    };
  },
}));

import type { UseVideoLookaheadOptions } from "./useVideoLookahead";

const { useVideoLookahead, getVideoStreamHit } = await import(
  "./useVideoLookahead"
);
const { enqueueStream, resetVideoCacheState } = await import(
  "@/providers/VideoCache"
);
const { storage } = await import("@/utils/mmkv");

const sameDeps = (
  a: readonly unknown[] | undefined,
  b: readonly unknown[] | undefined,
): boolean =>
  a === b ||
  (a !== undefined &&
    b !== undefined &&
    a.length === b.length &&
    a.every((value, i) => Object.is(value, b[i])));

const runEffects = (h: Harness, firstMount: boolean) => {
  for (const slot of h.effects) {
    if (!slot) continue;
    if (!firstMount && sameDeps(slot.prevDeps, slot.deps)) continue;
    slot.cleanup?.();
    slot.cleanup = slot.fn() ?? undefined;
    slot.prevDeps = slot.deps;
  }
};

const renderHook = (options: UseVideoLookaheadOptions) => {
  const harness: Harness = { refs: [], effects: [], position: 0 };
  const render = (opts: UseVideoLookaheadOptions) => {
    activeHarness = harness;
    harness.position = 0;
    try {
      // biome-ignore lint/correctness/useHookAtTopLevel: manual test harness renders the hook outside a React component on purpose (bun:test has no renderer)
      return useVideoLookahead(opts);
    } finally {
      activeHarness = null;
    }
  };
  const api = render(options);
  runEffects(harness, true);

  const rerender = (next: UseVideoLookaheadOptions) => {
    render(next);
    runEffects(harness, false);
  };

  const unmount = () => {
    for (const slot of harness.effects) {
      slot?.cleanup?.();
    }
  };

  return { api, rerender, unmount };
};

// Lets the prefetch loop (an unawaited async IIFE) settle against the real
// axios-mock-adapter + fake downloader.
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 10));

// --- Fixtures ---

const CURRENT_ITEM: BaseItemDto = {
  Id: "ep-1",
  Type: "Episode",
  SeriesId: "series-1",
};
const item = (id: string): BaseItemDto => ({
  Id: id,
  Type: "Episode",
  SeriesId: "series-1",
});

const directSource = (mediaSourceId: string, container = "mkv") => ({
  Id: mediaSourceId,
  Container: container,
  DirectStreamUrl: `/Videos/${mediaSourceId}/stream?static=true&container=${container}`,
});
const transcodeSource = (mediaSourceId: string) => ({
  Id: mediaSourceId,
  Container: "mp4",
  TranscodingUrl: `/Videos/${mediaSourceId}/hls.mp4/master.m3u8`,
});

const stubPlaybackInfo = (
  api: ReturnType<typeof makeApi>,
  itemId: string,
  mediaSource: unknown,
) => {
  api.mock
    .onPost(`https://jellyfin.example.com/Items/${itemId}/PlaybackInfo`)
    .reply(200, {
      PlaySessionId: `session-${itemId}`,
      MediaSources: [mediaSource],
    });
};

const makeSettings = (
  enabled: boolean,
  count: number,
  maxCacheSizeMB: number,
): Settings =>
  ({
    videoLookaheadEnabled: enabled,
    videoLookaheadCount: count,
    videoMaxCacheSizeMB: maxCacheSizeMB,
  }) as Settings;

const baseOptions = (
  overrides: Partial<UseVideoLookaheadOptions> = {},
): UseVideoLookaheadOptions => ({
  item: CURRENT_ITEM,
  nextItems: [item("ep-2"), item("ep-3")],
  settings: makeSettings(true, 1, 1024),
  api: null,
  userId: "user-1",
  audioStreamIndex: 0,
  subtitleStreamIndex: -1,
  maxStreamingBitrate: 8_000_000,
  ...overrides,
});

const indexEntryCount = (): number => {
  const raw = storage.getString(VIDEO_CACHE_INDEX_KEY);
  if (!raw) return 0;
  return Object.keys(
    (JSON.parse(raw) as { entries: Record<string, unknown> }).entries,
  ).length;
};

beforeEach(() => {
  clearFakeFileSystem();
  clearMmkv();
  resetVideoCacheState();
  nextTaskId = 1;
  completeListener = null;
  enqueued.length = 0;
  cancelledTaskIds.length = 0;
});

describe("B4: skip rules", () => {
  test("skips transcoding sources and enqueues direct ones, with the current session's rendition", async () => {
    const api = makeApi();
    stubPlaybackInfo(api, "ep-2", directSource("ms-2"));
    stubPlaybackInfo(api, "ep-3", transcodeSource("ms-3"));

    renderHook(
      baseOptions({
        api,
        settings: makeSettings(true, 3, 1024),
        nextItems: [item("ep-2"), item("ep-3")],
      }),
    );
    await flush();

    expect(enqueued.length).toBe(1);
    const url = enqueued[0]?.url ?? "";
    expect(url).toContain("/Videos/ep-2/stream?");
    expect(url).toContain("static=true");
    // The prefetch resolves from the top, like the follow-on session would.
    expect(url).toContain("startTimeTicks=0");
    expect(enqueued[0]?.destinationPath).toContain("streamyfin-video-cache");
    expect(enqueued[0]?.destinationPath).toContain(".mkv");

    // The negotiation carries the CURRENT playback's track selection.
    const playbackInfo = api.mock.history.post.find((request) =>
      request.url?.includes("/PlaybackInfo"),
    );
    const body = JSON.parse(playbackInfo?.data ?? "{}") as {
      startTimeTicks?: number;
      audioStreamIndex?: number;
      subtitleStreamIndex?: number;
      maxStreamingBitrate?: number;
    };
    expect(body.startTimeTicks).toBe(0);
    expect(body.audioStreamIndex).toBe(0);
    expect(body.subtitleStreamIndex).toBe(-1);
    expect(body.maxStreamingBitrate).toBe(8_000_000);
  });
});

describe("B7: feature disabled", () => {
  test("enabled=false: nothing is resolved or enqueued", async () => {
    const api = makeApi();
    stubPlaybackInfo(api, "ep-2", directSource("ms-2"));

    renderHook(baseOptions({ api, settings: makeSettings(false, 1, 1024) }));
    await flush();

    expect(enqueued.length).toBe(0);
    expect(api.mock.history.post.length).toBe(0);
  });

  test("enabled -> disabled cancels the in-flight downloads (completed files kept by the storage layer)", async () => {
    const api = makeApi();

    // A prefetch from a previous session is still downloading.
    await enqueueStream({
      itemId: "ep-9",
      mediaSourceId: "ms-9",
      url: "https://server.local/Videos/ep-9/stream.mkv",
      container: "mkv",
    });
    expect(enqueued.length).toBe(1);
    const inFlightTaskId = enqueued[0]?.taskId;

    const { rerender } = renderHook(
      baseOptions({
        api,
        settings: makeSettings(true, 1, 1024),
        nextItems: [],
      }),
    );
    await flush();

    rerender(
      baseOptions({
        api,
        settings: makeSettings(false, 1, 1024),
        nextItems: [],
      }),
    );

    expect(cancelledTaskIds).toContain(inFlightTaskId);
  });
});

describe("count = N", () => {
  test("count=2 enqueues exactly the next two items, in order", async () => {
    const api = makeApi();
    stubPlaybackInfo(api, "ep-2", directSource("ms-2"));
    stubPlaybackInfo(api, "ep-3", directSource("ms-3"));
    stubPlaybackInfo(api, "ep-4", directSource("ms-4"));

    renderHook(
      baseOptions({
        api,
        settings: makeSettings(true, 2, 1024),
        nextItems: [item("ep-2"), item("ep-3"), item("ep-4")],
      }),
    );
    await flush();

    expect(enqueued.length).toBe(2);
    expect(enqueued[0]?.url).toContain("/Videos/ep-2/");
    expect(enqueued[1]?.url).toContain("/Videos/ep-3/");
  });
});

describe("hit path key parity", () => {
  test("a completed prefetch resolves through the same key the hit path builds", async () => {
    const api = makeApi();
    stubPlaybackInfo(api, "ep-2", directSource("ms-2"));

    const { api: hookApi } = renderHook(baseOptions({ api }));
    await flush();
    const task = enqueued[0];
    if (!task?.destinationPath) {
      throw new Error("expected one enqueued download");
    }
    if (!completeListener) {
      throw new Error("expected the downloader complete listener to be wired");
    }

    // The native downloader wrote the file and reported completion.
    writeFile(task.destinationPath, "cached-video-bytes");
    completeListener({
      taskId: task.taskId,
      filePath: task.destinationPath,
      url: task.url,
    });
    await flush();

    // The player route's hit check: the SAME params the session resolves
    // with (item, resolved source, container, bitrate, track selection).
    const hitParams = {
      itemId: "ep-2",
      mediaSourceId: "ms-2",
      container: "mkv",
      maxBitrate: 8_000_000,
      audioStreamIndex: 0,
      subtitleStreamIndex: -1,
    };
    // The entry stores the file:// URI of the (bare) download destination —
    // the shape the player consumes directly.
    expect(hookApi.getStreamHit(hitParams)?.path).toBe(
      `file://${task.destinationPath}`,
    );
    // The standalone helper the native config route calls resolves too.
    expect(getVideoStreamHit(hitParams)?.path).toBe(
      `file://${task.destinationPath}`,
    );

    // A different rendition is a different key: no hit.
    expect(
      getVideoStreamHit({ ...hitParams, maxBitrate: 4_000_000 }),
    ).toBeNull();
  });

  test("no entry yet: the hit check is null before the download completes", async () => {
    const api = makeApi();
    stubPlaybackInfo(api, "ep-2", directSource("ms-2"));

    renderHook(baseOptions({ api }));
    await flush();
    expect(enqueued.length).toBe(1);

    expect(
      getVideoStreamHit({
        itemId: "ep-2",
        mediaSourceId: "ms-2",
        container: "mkv",
        maxBitrate: 8_000_000,
        audioStreamIndex: 0,
        subtitleStreamIndex: -1,
      }),
    ).toBeNull();
  });
});

describe("size budget", () => {
  test("a smaller maxCacheSizeMB evicts over-budget entries (reserveSpace)", async () => {
    const api = makeApi();

    // A leftover entry whose claimed size exceeds the 256MB option.
    const over = 300 * 1024 * 1024;
    const path = "file:///cache/streamyfin-video-cache/seed.mkv";
    writeFile(path, "seed");
    storage.set(
      VIDEO_CACHE_INDEX_KEY,
      JSON.stringify({
        entries: {
          "v1|seed": {
            streamKey: "v1|seed",
            itemId: "ep-old",
            mediaSourceId: "ms-old",
            url: "https://server.local/old.mkv",
            path,
            sizeBytes: over,
            storedAt: Date.now(),
          },
        },
        totalSizeBytes: over,
      }),
    );

    const { rerender } = renderHook(
      baseOptions({
        api,
        settings: makeSettings(true, 1, 1024),
        nextItems: [],
      }),
    );
    await flush();
    // 1024MB budget: the 300MB seed stays.
    expect(indexEntryCount()).toBe(1);

    rerender(
      baseOptions({
        api,
        settings: makeSettings(true, 1, 256),
        nextItems: [],
      }),
    );
    await flush();
    expect(indexEntryCount()).toBe(0);
  });
});

describe("guards", () => {
  test("without api or user nothing is resolved or enqueued", async () => {
    const api = makeApi();

    renderHook(baseOptions({ api: null, userId: null }));
    await flush();

    expect(enqueued.length).toBe(0);
    expect(api.mock.history.post.length).toBe(0);
  });
});
