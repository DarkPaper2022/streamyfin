import type { VideoStreamKeyParams } from "./types";

// Key version; bump when the segment format changes so old keys miss
// instead of colliding with new ones.
const STREAM_KEY_VERSION = "v1";

// `undefined` gets a fixed placeholder so "absent" stays stable across keys.
const segment = (value: string | number | undefined): string =>
  value === undefined ? "-" : String(value);

/**
 * Deterministic identity for one concrete rendition of a media source.
 *
 * The same parameters always produce the same key, and changing any single
 * parameter (item, source, container, bitrate, audio/subtitle track)
 * produces a different one. Direct and transcoded renditions of the same
 * source differ at least in `container`, so they never share a key.
 */
export function buildVideoStreamKey(params: VideoStreamKeyParams): string {
  const {
    itemId,
    mediaSourceId,
    container,
    maxBitrate,
    audioStreamIndex,
    subtitleStreamIndex,
  } = params;

  return [
    STREAM_KEY_VERSION,
    `i=${itemId}`,
    `m=${mediaSourceId}`,
    `c=${segment(container)}`,
    `b=${segment(maxBitrate)}`,
    `a=${segment(audioStreamIndex)}`,
    `s=${segment(subtitleStreamIndex)}`,
  ].join("|");
}
