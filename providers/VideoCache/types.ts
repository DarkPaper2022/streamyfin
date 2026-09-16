/**
 * Video Cache Types
 *
 * Shared types for the soft video lookahead cache: one index entry per
 * cached direct stream, addressed by a deterministic stream key.
 */

/** Parameters that identify one concrete rendition of a media source. */
export interface VideoStreamKeyParams {
  itemId: string;
  mediaSourceId: string;
  /** Original container for direct streams, transcoding container otherwise. */
  container?: string;
  maxBitrate?: number;
  audioStreamIndex?: number;
  subtitleStreamIndex?: number;
}

/** Everything needed to enqueue one direct stream for the lookahead cache. */
export interface VideoCacheEnqueueParams extends VideoStreamKeyParams {
  /** Direct stream URL captured at enqueue time. */
  url: string;
  /** Custom proxy auth headers for a Jellyfin behind an access gateway. */
  headers?: Record<string, string>;
}

/**
 * The URL shapes a media source can expose — the minimal structural slice
 * needed to decide whether the source is worth caching.
 */
export interface VideoStreamSource {
  DirectStreamUrl?: string;
  TranscodingUrl?: string;
}

/** One cached stream, as persisted in the index JSON. */
export interface VideoCacheEntry {
  streamKey: string;
  itemId: string;
  mediaSourceId: string;
  /** Direct stream URL at enqueue time; kept for re-download decisions. */
  url: string;
  /** `file://` URI of the cached file. */
  path: string;
  sizeBytes: number;
  /** ms epoch; the LRU ordering key. */
  storedAt: number;
  container?: string;
  maxBitrate?: number;
  audioStreamIndex?: number;
  subtitleStreamIndex?: number;
}

/** The persisted index. */
export interface VideoCacheIndex {
  /** Keyed by stream key. */
  entries: Record<string, VideoCacheEntry>;
  totalSizeBytes: number;
}

/**
 * Emitted after a download completed, the file was stat'ed, and the index
 * entry was persisted.
 */
export interface VideoCacheCompleteEvent {
  streamKey: string;
  itemId: string;
  path: string;
}

/** Emitted when an in-flight download fails (or its file vanished). */
export interface VideoCacheErrorEvent {
  streamKey: string;
  itemId: string;
  error: string;
}
