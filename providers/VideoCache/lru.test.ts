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
});
