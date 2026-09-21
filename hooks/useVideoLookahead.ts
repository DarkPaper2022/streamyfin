/**
 * Video Lookahead
 *
 * Prefetches the direct streams of the NEXT episodes while the current
 * episode plays, into the soft VideoCache (providers/VideoCache). The cache
 * is bandwidth-soft by design: downloads are serialized (the native
 * downloader enforces MAX_CONCURRENT=1), so playback keeps priority, and the
 * files live in the OS-evictable cache directory.
 *
 * The hook owns the PREFETCH side; the player routes call `getVideoStreamHit`
 * (this module) for the HIT side. Both sides build the same stream key
 * (buildVideoStreamKey over item / media source / container / bitrate /
 * track selection), so a prefetched rendition is found by the session that
 * would have played it from the network.
 */

import type { Api } from "@jellyfin/sdk";
import type { BaseItemDto } from "@jellyfin/sdk/lib/generated-client";
import { useEffect, useRef } from "react";
import {
  cancelAll,
  enqueueStream,
  getForKey,
  reserveSpace,
  setProtectedStreamKeys,
} from "@/providers/VideoCache";

import { buildVideoStreamKey } from "@/providers/VideoCache/streamKey";
import type {
  VideoCacheEntry,
  VideoStreamKeyParams,
} from "@/providers/VideoCache/types";
import type { Settings } from "@/utils/atoms/settings";
import { getActivePlayerType } from "@/utils/atoms/settings";
import { isExpectedError } from "@/utils/errors";
import { getStreamUrl } from "@/utils/jellyfin/media/getStreamUrl";
import { generateDeviceProfile } from "@/utils/profiles/native";

/**
 * Hit check for the player routes: builds the same stream key the lookahead
 * enqueues with, and resolves it against the cache. Null when the entry is
 * missing or stale (stale cleanup is the storage layer's job).
 */
export const getVideoStreamHit = (
  params: VideoStreamKeyParams,
): VideoCacheEntry | null => getForKey(buildVideoStreamKey(params));

export interface UseVideoLookaheadOptions {
  /** The item of the session being played (null before it loads). */
  item: BaseItemDto | null | undefined;
  /**
   * Upcoming items in playback order, from usePlaybackManager — the source of
   * truth for "next item"; the hook never re-derives them.
   */
  nextItems: readonly BaseItemDto[];
  /** Effective settings; the videoLookahead* fields gate and size the cache. */
  settings: Settings | null | undefined;
  api: Api | null | undefined;
  userId: string | null | undefined;
  /** The current session's rendition — what a follow-on session carries. */
  audioStreamIndex?: number;
  subtitleStreamIndex?: number;
  maxStreamingBitrate?: number;
}

export interface UseVideoLookahead {
  /** The player routes' hit check (see getVideoStreamHit). */
  getStreamHit: (params: VideoStreamKeyParams) => VideoCacheEntry | null;
}

export const useVideoLookahead = (
  options: UseVideoLookaheadOptions,
): UseVideoLookahead => {
  const {
    item,
    nextItems,
    settings,
    api,
    userId,
    audioStreamIndex,
    subtitleStreamIndex,
    maxStreamingBitrate,
  } = options;

  const enabled = settings?.videoLookaheadEnabled ?? false;
  const count = settings?.videoLookaheadCount ?? 0;
  const maxCacheSizeMB = settings?.videoMaxCacheSizeMB ?? 1024;

  // enabled -> disabled: cancel the in-flight downloads. Completed files are
  // kept by the storage layer, so a re-enable finds a warm cache.
  const wasEnabledRef = useRef(enabled);
  useEffect(() => {
    if (wasEnabledRef.current && !enabled) {
      cancelAll();
    }
    wasEnabledRef.current = enabled;
  }, [enabled]);

  // Size budget: applied on mount and whenever the setting changes, so a
  // smaller cache evicts down to the new budget immediately.
  useEffect(() => {
    if (!enabled) return;
    void reserveSpace(maxCacheSizeMB);
  }, [enabled, maxCacheSizeMB]);

  // Update protected stream keys: the current item and immediate lookahead
  // targets should not be evicted by LRU while in active playback scope.
  useEffect(() => {
    if (!enabled) {
      setProtectedStreamKeys([]);
      return;
    }
    const protectedKeys: string[] = [];
    if (item?.Id) {
      protectedKeys.push(
        buildVideoStreamKey({
          itemId: item.Id,
          mediaSourceId: item.Id,
          audioStreamIndex,
          subtitleStreamIndex,
          maxBitrate: maxStreamingBitrate,
        }),
      );
    }
    for (const next of nextItems.slice(0, count)) {
      if (next.Id) {
        protectedKeys.push(
          buildVideoStreamKey({
            itemId: next.Id,
            mediaSourceId: next.Id,
            audioStreamIndex,
            subtitleStreamIndex,
            maxBitrate: maxStreamingBitrate,
          }),
        );
      }
    }
    setProtectedStreamKeys(protectedKeys);
  }, [
    enabled,
    count,
    item?.Id,
    nextItems,
    audioStreamIndex,
    subtitleStreamIndex,
    maxStreamingBitrate,
  ]);

  // The device profile is read from a ref inside the prefetch effect (same
  // mirror pattern as the progress reporters in the player routes): it must
  // stay in step with the settings without re-triggering a re-negotiation on
  // unrelated settings churn.
  const deviceProfileRef = useRef<
    ReturnType<typeof generateDeviceProfile> | undefined
  >(undefined);
  useEffect(() => {
    deviceProfileRef.current = settings
      ? generateDeviceProfile({
          player: getActivePlayerType(settings),
          audioMode: settings.audioTranscodeMode,
        })
      : undefined;
  });

  // Prefetch the next `count` items, one negotiation at a time.
  useEffect(() => {
    if (!enabled || count <= 0) return;
    const itemId = item?.Id;
    if (!itemId || !api || !userId || nextItems.length === 0) return;

    let cancelled = false;
    const targets = nextItems.slice(0, count);
    const deviceProfile = deviceProfileRef.current;

    void (async () => {
      // Serial: the native downloader serializes too (MAX_CONCURRENT=1), so
      // playback keeps bandwidth priority over the prefetch.
      for (const next of targets) {
        if (cancelled) break;
        const nextId = next.Id;
        if (!nextId) continue;
        try {
          // Resolve the stream the player WOULD pick for this item: the same
          // device profile and track selection as the current session, from
          // the top (startTimeTicks=0).
          const res = await getStreamUrl({
            api,
            item: next,
            userId,
            startTimeTicks: 0,
            maxStreamingBitrate,
            audioStreamIndex,
            subtitleStreamIndex,
            deviceProfile,
          });
          if (cancelled || !res?.url || !res.mediaSource) continue;
          const { mediaSource } = res;
          const mediaSourceId = mediaSource.Id;
          if (!mediaSourceId) continue;
          // Only direct streams are cacheable: a transcoded rendition (the
          // server answered with a TranscodingUrl, i.e. HLS) cannot be stored
          // as one file, so it is skipped. The direct URL is res.url.
          if (mediaSource.TranscodingUrl) continue;
          await enqueueStream({
            itemId: nextId,
            mediaSourceId,
            url: res.url,
            container: mediaSource.Container ?? undefined,
            maxBitrate: maxStreamingBitrate,
            audioStreamIndex,
            subtitleStreamIndex,
            headers: res.requiredHttpHeaders,
          });
        } catch (error) {
          // A failed prefetch must never surface into the player. Expected
          // errors are server-side rejections (NoCompatibleStream, ...);
          // anything else is logged as a defect. The remaining items proceed.
          if (isExpectedError(error)) {
            console.warn(
              `[VideoLookahead] Server declined the stream for ${nextId}`,
              error,
            );
          } else {
            console.error(
              `[VideoLookahead] Failed to resolve the stream for ${nextId}`,
              error,
            );
          }
        }
      }
    })();

    return () => {
      // The session moved on (item switch / unmount): stop the stale loop.
      // Already-enqueued downloads keep going — they belong to the cache,
      // not to this render.
      cancelled = true;
    };
  }, [
    enabled,
    count,
    item?.Id,
    nextItems,
    api,
    userId,
    audioStreamIndex,
    subtitleStreamIndex,
    maxStreamingBitrate,
  ]);

  return { getStreamHit: getVideoStreamHit };
};
