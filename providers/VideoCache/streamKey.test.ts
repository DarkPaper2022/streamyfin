import { describe, expect, test } from "bun:test";

import { buildVideoStreamKey } from "./streamKey";
import type { VideoStreamKeyParams } from "./types";

const base: VideoStreamKeyParams = {
  itemId: "a4076c60977cd217655224e2f0e52690",
  mediaSourceId: "ms-1",
  container: "mkv",
};

const withParams = (
  patch: Partial<VideoStreamKeyParams>,
): VideoStreamKeyParams => ({
  ...base,
  ...patch,
});

describe("buildVideoStreamKey", () => {
  test("returns the same key for identical params", () => {
    expect(buildVideoStreamKey(base)).toBe(buildVideoStreamKey({ ...base }));
  });

  test("treats absent and undefined optional params identically", () => {
    expect(buildVideoStreamKey({ itemId: "i", mediaSourceId: "m" })).toBe(
      buildVideoStreamKey({
        itemId: "i",
        mediaSourceId: "m",
        container: undefined,
        maxBitrate: undefined,
        audioStreamIndex: undefined,
        subtitleStreamIndex: undefined,
      }),
    );
  });

  test("differs between a transcoded and a direct rendition", () => {
    const transcoded = withParams({ container: "ts", maxBitrate: 1_500_000 });
    expect(buildVideoStreamKey(transcoded)).not.toBe(buildVideoStreamKey(base));
  });

  test("differs when the container changes", () => {
    expect(buildVideoStreamKey(withParams({ container: "mkv" }))).not.toBe(
      buildVideoStreamKey(withParams({ container: "mp4" })),
    );
  });

  test("differs when the maxBitrate changes", () => {
    expect(buildVideoStreamKey(withParams({ maxBitrate: 1_500_000 }))).not.toBe(
      buildVideoStreamKey(withParams({ maxBitrate: 2_000_000 })),
    );
    expect(buildVideoStreamKey(withParams({ maxBitrate: 1_500_000 }))).not.toBe(
      buildVideoStreamKey(withParams({})),
    );
  });

  test("differs when the audioStreamIndex changes", () => {
    expect(buildVideoStreamKey(withParams({ audioStreamIndex: 0 }))).not.toBe(
      buildVideoStreamKey(withParams({ audioStreamIndex: 1 })),
    );
  });

  test("differs when the subtitleStreamIndex changes", () => {
    expect(
      buildVideoStreamKey(withParams({ subtitleStreamIndex: 0 })),
    ).not.toBe(buildVideoStreamKey(withParams({ subtitleStreamIndex: 2 })));
  });

  test("differs when the itemId or mediaSourceId changes", () => {
    expect(buildVideoStreamKey(withParams({ itemId: "other" }))).not.toBe(
      buildVideoStreamKey(base),
    );
    expect(buildVideoStreamKey(withParams({ mediaSourceId: "ms-2" }))).not.toBe(
      buildVideoStreamKey(base),
    );
  });
});
