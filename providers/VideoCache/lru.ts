/**
 * Pure LRU selection for the video cache index. Entries are ordered by
 * `storedAt` (oldest first) and evicted until both the entry count and the
 * total size fit the limits.
 */

export interface CacheEntryLike {
  streamKey: string;
  storedAt: number;
  sizeBytes: number;
}

export interface EvictionLimits {
  maxEntries: number;
  maxSizeBytes: number;
}

/**
 * Returns the entries to evict, oldest `storedAt` first, for an index that
 * exceeds either limit. Returns an empty list when nothing must go. A single
 * entry that alone exceeds the size budget is evicted too: an over-budget
 * cache is worse than an empty one.
 */
export function selectEntriesToEvict<T extends CacheEntryLike>(
  entries: ReadonlyArray<T>,
  limits: EvictionLimits,
): Array<T> {
  const ordered = [...entries].sort((a, b) => a.storedAt - b.storedAt);
  let totalSizeBytes = entries.reduce((sum, entry) => sum + entry.sizeBytes, 0);
  const evicted: Array<T> = [];

  while (
    ordered.length > limits.maxEntries ||
    totalSizeBytes > limits.maxSizeBytes
  ) {
    const oldest = ordered.shift();
    if (!oldest) break;
    evicted.push(oldest);
    totalSizeBytes -= oldest.sizeBytes;
  }

  return evicted;
}
