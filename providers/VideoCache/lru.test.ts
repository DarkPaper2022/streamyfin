import { describe, expect, test } from "bun:test";
import type { CacheEntryLike } from "./lru";
import { selectEntriesToEvict } from "./lru";

const entry = (
  n: number,
  patch: Partial<CacheEntryLike> = {},
): CacheEntryLike => ({
  streamKey: `key-${n}`,
  // storedAt doubles as the age: smaller = older
  storedAt: n,
  sizeBytes: 100,
  ...patch,
});

describe("selectEntriesToEvict", () => {
  test("evicts nothing when within both limits", () => {
    const entries = [entry(1), entry(2)];
    expect(
      selectEntriesToEvict(entries, { maxEntries: 3, maxSizeBytes: 1_000 }),
    ).toEqual([]);
  });

  test("evicts the oldest-storedAt entries when over the count limit", () => {
    const entries = [entry(1), entry(2), entry(3), entry(4)];
    const evicted = selectEntriesToEvict(entries, {
      maxEntries: 2,
      maxSizeBytes: 10_000,
    });
    expect(evicted.map((e) => e.streamKey)).toEqual(["key-1", "key-2"]);
  });

  test("evicts oldest-first until the size limit fits", () => {
    const entries = [
      entry(1, { sizeBytes: 60 }),
      entry(2, { sizeBytes: 50 }),
      entry(3, { sizeBytes: 40 }),
    ];
    // 150 > 90 → evict key-1 (60); 90 no longer exceeds 90
    const evicted = selectEntriesToEvict(entries, {
      maxEntries: 10,
      maxSizeBytes: 90,
    });
    expect(evicted.map((e) => e.streamKey)).toEqual(["key-1"]);
  });

  test("does not depend on input order", () => {
    const entries = [entry(3), entry(1), entry(2)];
    const evicted = selectEntriesToEvict(entries, {
      maxEntries: 1,
      maxSizeBytes: 10_000,
    });
    expect(evicted.map((e) => e.streamKey)).toEqual(["key-1", "key-2"]);
  });

  test("returns nothing for an empty index", () => {
    expect(
      selectEntriesToEvict([], { maxEntries: 20, maxSizeBytes: 1_024 }),
    ).toEqual([]);
  });

  test("evicts a single entry that alone exceeds the size limit", () => {
    const evicted = selectEntriesToEvict([entry(1, { sizeBytes: 200 })], {
      maxEntries: 20,
      maxSizeBytes: 100,
    });
    expect(evicted.map((e) => e.streamKey)).toEqual(["key-1"]);
  });

  test("unlimited size limit (maxSizeBytes <= 0) does not evict on size", () => {
    const entries = [
      entry(1, { sizeBytes: 10_000 }),
      entry(2, { sizeBytes: 20_000 }),
    ];
    const evicted = selectEntriesToEvict(entries, {
      maxEntries: 20,
      maxSizeBytes: 0,
    });
    expect(evicted).toEqual([]);
  });

  test("evicts when free disk space is below minFreeDiskBytes until target is satisfied", () => {
    const entries = [
      entry(1, { sizeBytes: 1_000 }),
      entry(2, { sizeBytes: 2_000 }),
      entry(3, { sizeBytes: 3_000 }),
    ];
    // freeDiskBytes: 2,000; minFreeDiskBytes: 4,500; deficit: 2,500
    // evict key-1 (1,000 freed -> 3,000 < 4,500)
    // evict key-2 (2,000 freed -> 5,000 >= 4,500) -> stops!
    const evicted = selectEntriesToEvict(entries, {
      maxEntries: 20,
      maxSizeBytes: 0,
      freeDiskBytes: 2_000,
      minFreeDiskBytes: 4_500,
    });
    expect(evicted.map((e) => e.streamKey)).toEqual(["key-1", "key-2"]);
  });

  test("prioritizes evicting unprotected entries before touching protected keys", () => {
    const entries = [
      entry(1, { sizeBytes: 1_000 }), // protected (e.g. current playing)
      entry(2, { sizeBytes: 1_000 }), // unprotected
      entry(3, { sizeBytes: 1_000 }), // unprotected
    ];
    // Need to evict 1 entry to satisfy maxEntries = 2
    const evicted = selectEntriesToEvict(entries, {
      maxEntries: 2,
      maxSizeBytes: 100_000,
      protectedKeys: new Set(["key-1"]),
    });
    // Should evict key-2 (oldest unprotected), NOT key-1
    expect(evicted.map((e) => e.streamKey)).toEqual(["key-2"]);
  });
});
