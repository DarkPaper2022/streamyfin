import { describe, expect, mock, test } from "bun:test";
import type { BaseItemDto } from "@jellyfin/sdk/lib/generated-client";
import type { TFunction } from "i18next";
import { atom, createStore } from "jotai";
import type { DownloadedItem } from "@/providers/Downloads/types";
import { Directory, File, Paths } from "@/test-utils/expoFileSystem";
import { stubMmkv } from "@/test-utils/mmkv";
import { stubReactNative } from "@/test-utils/reactNative";
import type { Settings } from "./settings";

// Non-TV platform: the hold-to-speed flags are mapped into the native config
// as `!Platform.isTV && settings.*`, so a TV platform would mask the mapping.
stubReactNative({ OS: "ios" });
stubMmkv();
mock.module("expo", () => ({
  // codecSupport probes the native MPV module; under bun:test there is none.
  requireOptionalNativeModule: () => null,
}));
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
// which bun:test cannot load. Mirror the real OrientationLock values so the
// stored defaultVideoOrientation (DEFAULT) resolves the same way.
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
// buildNativePlayerConfig now resolves the video look-ahead cache hit, which
// links the VideoCache module graph: stub the same native leaves as
// providers/VideoCache/index.test.ts.
mock.module("expo-file-system", () => ({ Paths, Directory, File }));
mock.module("@/modules", () => ({
  BackgroundDownloader: {
    enqueueDownload: async () => 0,
    cancelDownload: () => undefined,
    addCompleteListener: () => ({ remove() {} }),
    addErrorListener: () => ({ remove() {} }),
  },
}));

const { defaultValues, effectiveSettingsAtom, settingsAtom } = await import(
  "./settings"
);
const { buildNativePlayerConfig, buildNativePlayerStrings } = await import(
  "../nativePlayer/buildNativePlayerConfig"
);

// i18next is not initialized under bun:test; the config builder only needs
// the label strings, so an identity translator is enough.
const t = ((key: string) => key) as unknown as TFunction;

const itemId = "item-1";
const item: BaseItemDto = {
  Id: itemId,
  Name: "Hold Speed Movie",
  Type: "Movie",
};

// An offline session needs no network at all: the stream is seeded from the
// download record, and the hold-to-speed mapping only reads the settings.
const downloadedItem: DownloadedItem = {
  item,
  mediaSource: { Id: "media-1" },
  videoFilePath: "/downloads/item-1.mkv",
  videoFileSize: 1024,
  userData: {
    subtitleStreamIndex: -1,
    audioStreamIndex: 0,
    isTranscoded: false,
  },
};

const buildConfig = async (settings: Settings) => {
  const result = await buildNativePlayerConfig({
    api: null,
    userId: undefined,
    settings,
    item,
    req: {
      itemId,
      offline: true,
      audioIndex: 0,
      subtitleIndex: -1,
    },
    getDownloadedItemById: (id) => (id === itemId ? downloadedItem : undefined),
    strings: buildNativePlayerStrings(t),
  });
  expect(result).not.toBeNull();
  return result!.config;
};

describe("A6: hold-to-speed settings defaults", () => {
  test("defaultValues ships enableHoldToSpeed on at a 2x rate", () => {
    expect(defaultValues.enableHoldToSpeed).toBe(true);
    expect(defaultValues.holdToSpeedRate).toBe(2.0);
  });

  test("the effective settings atom resolves both defaults with no stored settings", () => {
    // A pristine store holds the atom's initial values (settingsAtom null,
    // no plugin settings) — the read path that every first launch goes through.
    const effective = createStore().get(effectiveSettingsAtom);
    expect(effective.enableHoldToSpeed).toBe(true);
    expect(effective.holdToSpeedRate).toBe(2.0);
  });
});

describe("A7: native player config mapping", () => {
  test("default settings map to an enabled 2x hold-to-speed", async () => {
    const config = await buildConfig(defaultValues);
    expect(config.ui?.holdToSpeedEnabled).toBe(true);
    expect(config.ui?.holdToSpeedRate).toBe(2.0);
  });

  test("flipping the settings atoms flips the built config", async () => {
    const store = createStore();
    store.set(settingsAtom, {
      enableHoldToSpeed: false,
      holdToSpeedRate: 3.0,
    });
    const effective = store.get(effectiveSettingsAtom);
    expect(effective.enableHoldToSpeed).toBe(false);
    expect(effective.holdToSpeedRate).toBe(3.0);

    const config = await buildConfig(effective);
    expect(config.ui?.holdToSpeedEnabled).toBe(false);
    expect(config.ui?.holdToSpeedRate).toBe(3.0);
  });
});
