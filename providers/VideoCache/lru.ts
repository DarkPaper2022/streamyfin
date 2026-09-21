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
  /** Max cache size budget in bytes. <= 0 indicates unlimited size budget. */
  maxSizeBytes: number;
  /** Current device free disk space in bytes (optional). */
  freeDiskBytes?: number;
  /**
   * Minimum required free disk space in bytes (optional).
   * If freeDiskBytes is provided and < minFreeDiskBytes, eviction continues
   * until free disk space + freed bytes >= minFreeDiskBytes.
   */
  minFreeDiskBytes?: number;
  /**
   * Stream keys or item identifiers protected from eviction (e.g. current
   * playing item or adjacent lookahead targets).
   */
  protectedKeys?: ReadonlySet<string>;
}

/**
 * Returns the entries to evict, oldest `storedAt` first, for an index that
 * exceeds the limits. Returns an empty list when nothing must go.
 *
 * Eviction occurs if:
 * 1. Total entry count > limits.maxEntries
 * 2. limits.maxSizeBytes > 0 AND totalSizeBytes > limits.maxSizeBytes
 * 3. freeDiskBytes is known AND (freeDiskBytes + freedBytes) < minFreeDiskBytes
 *
 * Entries matching `protectedKeys` are skipped unless all candidates are exhausted.
 */
export function selectEntriesToEvict<T extends CacheEntryLike>(
  entries: ReadonlyArray<T>,
  limits: EvictionLimits,
): Array<T> {
  const protectedSet = limits.protectedKeys;
  const isProtected = (entry: T) => protectedSet?.has(entry.streamKey) ?? false;

  // Separate into candidates (unprotected) and protected
  const candidates = entries
    .filter((e) => !isProtected(e))
    .sort((a, b) => a.storedAt - b.storedAt);
  const protectedList = entries
    .filter(isProtected)
    .sort((a, b) => a.storedAt - b.storedAt);

  // Evict candidates first, and only touch protected ones if absolutely necessary
  const ordered = [...candidates, ...protectedList];

  let remainingCount = entries.length;
  let totalSizeBytes = entries.reduce((sum, entry) => sum + entry.sizeBytes, 0);
  let freedBytes = 0;
  const evicted: Array<T> = [];

  const shouldEvict = () => {
    if (remainingCount > limits.maxEntries) return true;
    if (limits.maxSizeBytes > 0 && totalSizeBytes > limits.maxSizeBytes)
      return true;
    if (
      limits.freeDiskBytes !== undefined &&
      limits.minFreeDiskBytes !== undefined &&
      limits.freeDiskBytes + freedBytes < limits.minFreeDiskBytes
    ) {
      return true;
    }
    return false;
  };

  while (shouldEvict()) {
    const oldest = ordered.shift();
    if (!oldest) break;
    evicted.push(oldest);
    remainingCount -= 1;
    totalSizeBytes -= oldest.sizeBytes;
    freedBytes += oldest.sizeBytes;
  }

  return evicted;
}
