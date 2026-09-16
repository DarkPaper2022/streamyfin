import { describe, expect, mock, test } from "bun:test";
import { atom } from "jotai";
import { stubMmkv } from "@/test-utils/mmkv";
import { stubReactNative } from "@/test-utils/reactNative";

// Platform stub mirrored from settings.test.ts — the defaults under test are
// platform-independent, but settings.ts must link with Platform, MMKV and the
// native-backed modules stubbed.
stubReactNative({ OS: "android", isTV: true });
stubMmkv();
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

const { defaultValues } = await import("./settings");

// Scenario B6: the video look-ahead cache (cross-episode soft cache, design
// decision D6) mirrors the audio look-ahead settings. `defaultValues` is the
// atom's default-value source — effectiveSettingsAtom and updateSettings both
// resolve unset keys against it, so these are the values a fresh install sees.
// The UI option sets are [1, 2, 3] for the count and
// [256, 512, 1024, 2048, 4096] for the cache size (a later task).
describe("video look-ahead cache defaults (B6)", () => {
  test("videoLookaheadEnabled defaults to true", () => {
    expect(defaultValues.videoLookaheadEnabled).toBe(true);
  });

  test("videoLookaheadCount defaults to 1", () => {
    expect(defaultValues.videoLookaheadCount).toBe(1);
  });

  test("videoMaxCacheSizeMB defaults to 1024", () => {
    expect(defaultValues.videoMaxCacheSizeMB).toBe(1024);
  });
});
