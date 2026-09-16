import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { GestureResponderEvent } from "react-native";
import { stubReactNative } from "@/test-utils/reactNative";
import type { SwipeGestureOptions } from "./useGestureDetection";

// Characterization tests for useGestureDetection: they lock the hook's
// existing behavior and change no production code.
//
// bun:test cannot load react in a render context and the repo has no
// renderer, so the three hooks useGestureDetection calls are replaced with
// a minimal per-render harness. mock.module is global and re-links every
// importer, so the factory spreads the real module: specs that load later
// in the same run (jotai) must still see the full react surface.
stubReactNative();
const realReact = await import("react");

let activeHarness: HookHarness | null = null;
mock.module("react", () => ({
  ...realReact,
  useRef: (initial: unknown) => {
    if (!activeHarness) throw new Error("hook ran outside renderHook");
    return activeHarness.useRef(initial);
  },
  useCallback: (fn: unknown) => {
    if (!activeHarness) throw new Error("hook ran outside renderHook");
    return activeHarness.useCallback(fn);
  },
  useEffect: (fn: () => (() => void) | undefined) => {
    if (!activeHarness) throw new Error("hook ran outside renderHook");
    activeHarness.useEffect(fn);
  },
}));

const { useGestureDetection } = await import("./useGestureDetection");

type FakeTimer = { id: number; due: number; fn: () => void };
type HookHarness = {
  useRef: <T>(initial: T) => { current: T };
  useCallback: <T>(fn: T) => T;
  useEffect: (fn: () => (() => void) | undefined) => void;
  mount: () => Array<(() => void) | undefined>;
};

const createHarness = (): HookHarness => {
  const effects: Array<() => (() => void) | undefined> = [];
  return {
    useRef: (initial) => ({ current: initial }),
    useCallback: (fn) => fn,
    useEffect: (fn) => {
      effects.push(fn);
    },
    mount: () => effects.map((run) => run()),
  };
};

// The hook reads Date.now and schedules the long press through the global
// setTimeout, so a virtual clock drives every scenario deterministically.
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const realDateNow = Date.now;

let virtualNow = 0;
let pendingTimers: FakeTimer[] = [];
let nextTimerId = 1;

const installFakeClock = () => {
  virtualNow = 0;
  pendingTimers = [];
  nextTimerId = 1;
  globalThis.setTimeout = ((fn: () => void, ms?: number) => {
    const id = nextTimerId;
    nextTimerId += 1;
    pendingTimers.push({ id, due: virtualNow + (ms ?? 0), fn });
    return id;
  }) as unknown as typeof globalThis.setTimeout;
  globalThis.clearTimeout = ((id: number) => {
    pendingTimers = pendingTimers.filter((timer) => timer.id !== id);
  }) as unknown as typeof globalThis.clearTimeout;
  Date.now = () => virtualNow;
};

const restoreRealClock = () => {
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
  Date.now = realDateNow;
};

const earliestDueTimer = (target: number): FakeTimer | undefined =>
  pendingTimers
    .filter((timer) => timer.due <= target)
    .sort((a, b) => a.due - b.due || a.id - b.id)[0];

/** Runs every fake timer that comes due within `ms` milliseconds. */
const advanceClock = (ms: number) => {
  const target = virtualNow + ms;
  let next = earliestDueTimer(target);
  while (next) {
    const due = next;
    virtualNow = due.due;
    pendingTimers = pendingTimers.filter((timer) => timer.id !== due.id);
    due.fn();
    next = earliestDueTimer(target);
  }
  virtualNow = target;
};

const renderHook = (options: SwipeGestureOptions) => {
  const harness = createHarness();
  activeHarness = harness;
  const api = useGestureDetection(options);
  activeHarness = null;
  const cleanups = harness.mount();
  return {
    api,
    unmount: () => {
      for (const cleanup of cleanups) {
        if (typeof cleanup === "function") cleanup();
      }
    },
  };
};

const makeEvent = (pageX: number, pageY: number): GestureResponderEvent =>
  ({ nativeEvent: { pageX, pageY } }) as GestureResponderEvent;

const spies = () => ({
  onTap: mock(() => {}),
  onLongPressStart: mock(() => {}),
  onLongPressEnd: mock(() => {}),
  onSwipeLeft: mock(() => {}),
  onSwipeRight: mock(() => {}),
  onVerticalDragStart: mock(() => {}),
  onVerticalDragEnd: mock(() => {}),
});

beforeEach(installFakeClock);
afterEach(restoreRealClock);

describe("A1: press held past longPressDuration starts the long press", () => {
  test("fires exactly when the 500ms default elapses, not before", () => {
    const s = spies();
    const { api } = renderHook(s);

    api.handleTouchStart(makeEvent(200, 400));
    advanceClock(499);

    expect(s.onLongPressStart).not.toHaveBeenCalled();

    advanceClock(1);

    expect(s.onLongPressStart).toHaveBeenCalledTimes(1);
  });
});

describe("A2: movement beyond the 8px slop cancels the pending long press", () => {
  test("a 9px move kills the timer and the release fires nothing", () => {
    const s = spies();
    const { api } = renderHook(s);

    api.handleTouchStart(makeEvent(200, 400));
    api.handleTouchMove(makeEvent(209, 400)); // 9px > 8px slop
    advanceClock(600);

    expect(s.onLongPressStart).not.toHaveBeenCalled();

    api.handleTouchEnd(makeEvent(209, 400));

    expect(s.onLongPressEnd).not.toHaveBeenCalled();
    expect(s.onTap).not.toHaveBeenCalled();
    expect(s.onSwipeLeft).not.toHaveBeenCalled();
    expect(s.onSwipeRight).not.toHaveBeenCalled();
  });

  test("a move of exactly 8px does not cancel, so the press still lands", () => {
    const s = spies();
    const { api } = renderHook(s);

    api.handleTouchStart(makeEvent(200, 400));
    api.handleTouchMove(makeEvent(208, 400)); // 8px is not > 8px
    advanceClock(500);

    expect(s.onLongPressStart).toHaveBeenCalledTimes(1);

    api.handleTouchEnd(makeEvent(208, 400));

    expect(s.onLongPressEnd).toHaveBeenCalledTimes(1);
  });

  test("the pending timer is cleared on unmount", () => {
    const s = spies();
    const { api, unmount } = renderHook(s);

    api.handleTouchStart(makeEvent(200, 400));
    unmount();
    advanceClock(600);

    expect(s.onLongPressStart).not.toHaveBeenCalled();
  });
});

describe("A3: releasing before the threshold is a short press, not a long press", () => {
  test("a 200ms hold with no travel is a tap", () => {
    const s = spies();
    const { api } = renderHook(s);

    api.handleTouchStart(makeEvent(200, 400));
    advanceClock(200);
    api.handleTouchEnd(makeEvent(200, 400));

    expect(s.onTap).toHaveBeenCalledTimes(1);
    expect(s.onLongPressStart).not.toHaveBeenCalled();
    expect(s.onLongPressEnd).not.toHaveBeenCalled();
  });

  test("a 400ms hold fires nothing (past the 300ms tap window, under the 500ms long press)", () => {
    const s = spies();
    const { api } = renderHook(s);

    api.handleTouchStart(makeEvent(200, 400));
    advanceClock(400);
    api.handleTouchEnd(makeEvent(200, 400));

    expect(s.onTap).not.toHaveBeenCalled();
    expect(s.onLongPressStart).not.toHaveBeenCalled();
    expect(s.onLongPressEnd).not.toHaveBeenCalled();
  });
});

describe("A4: release after a triggered long press fires onLongPressEnd exactly once", () => {
  test("release fires end once, with no tap, swipe or drag end", () => {
    const s = spies();
    const { api } = renderHook(s);

    api.handleTouchStart(makeEvent(200, 400));
    advanceClock(500);

    expect(s.onLongPressStart).toHaveBeenCalledTimes(1);

    // Movement while holding is ignored, so the release cannot become a swipe
    api.handleTouchMove(makeEvent(260, 400));

    expect(s.onVerticalDragStart).not.toHaveBeenCalled();

    api.handleTouchEnd(makeEvent(260, 400));

    expect(s.onLongPressEnd).toHaveBeenCalledTimes(1);
    expect(s.onTap).not.toHaveBeenCalled();
    expect(s.onSwipeLeft).not.toHaveBeenCalled();
    expect(s.onSwipeRight).not.toHaveBeenCalled();
    expect(s.onVerticalDragEnd).not.toHaveBeenCalled();
  });

  test("extra touches while holding are ignored and do not re-trigger the start", () => {
    const s = spies();
    const { api } = renderHook(s);

    api.handleTouchStart(makeEvent(200, 400));
    advanceClock(500);
    api.handleTouchStart(makeEvent(100, 400));
    advanceClock(500);

    expect(s.onLongPressStart).toHaveBeenCalledTimes(1);

    api.handleTouchEnd(makeEvent(100, 400));

    expect(s.onLongPressEnd).toHaveBeenCalledTimes(1);
  });
});

describe("A5: exclusion zones are ignored and touch cancel resets state", () => {
  test("a touch starting in the top 15% zone is completely inert", () => {
    // default screenHeight 800: the top exclusion zone is pageY < 120
    const s = spies();
    const { api } = renderHook(s);

    api.handleTouchStart(makeEvent(200, 50));
    advanceClock(600);
    api.handleTouchMove(makeEvent(220, 90));
    api.handleTouchEnd(makeEvent(220, 90));

    expect(s.onLongPressStart).not.toHaveBeenCalled();
    expect(s.onLongPressEnd).not.toHaveBeenCalled();
    expect(s.onTap).not.toHaveBeenCalled();
    expect(s.onSwipeLeft).not.toHaveBeenCalled();
    expect(s.onSwipeRight).not.toHaveBeenCalled();
    expect(s.onVerticalDragStart).not.toHaveBeenCalled();
  });

  test("a touch starting in the bottom 15% zone is completely inert", () => {
    // default screenHeight 800: the bottom exclusion zone is pageY > 680
    const s = spies();
    const { api } = renderHook(s);

    api.handleTouchStart(makeEvent(200, 750));
    advanceClock(600);
    api.handleTouchEnd(makeEvent(200, 750));

    expect(s.onLongPressStart).not.toHaveBeenCalled();
    expect(s.onTap).not.toHaveBeenCalled();
  });

  test("a touch starting exactly on the 15% boundary is not excluded", () => {
    const s = spies();
    const { api } = renderHook(s);

    api.handleTouchStart(makeEvent(200, 120)); // 120 < 120 is false
    advanceClock(500);

    expect(s.onLongPressStart).toHaveBeenCalledTimes(1);
  });

  test("cancel clears a pending timer so the next touch can long-press", () => {
    const s = spies();
    const { api } = renderHook(s);

    api.handleTouchStart(makeEvent(200, 400));
    api.handleTouchCancel();
    advanceClock(600);

    expect(s.onLongPressStart).not.toHaveBeenCalled();
    expect(s.onLongPressEnd).not.toHaveBeenCalled();

    api.handleTouchStart(makeEvent(200, 400));
    advanceClock(500);

    expect(s.onLongPressStart).toHaveBeenCalledTimes(1);

    api.handleTouchEnd(makeEvent(200, 400));

    expect(s.onLongPressEnd).toHaveBeenCalledTimes(1);
  });

  test("cancel clears an ignored-touch flag from a prior exclusion-zone start", () => {
    const s = spies();
    const { api } = renderHook(s);

    api.handleTouchStart(makeEvent(200, 50)); // ignored start sets the flag
    api.handleTouchMove(makeEvent(250, 400)); // swallowed by the flag

    expect(s.onVerticalDragStart).not.toHaveBeenCalled();

    api.handleTouchCancel();
    api.handleTouchStart(makeEvent(200, 400));
    advanceClock(500);

    expect(s.onLongPressStart).toHaveBeenCalledTimes(1);
  });

  test("cancel during an active long press releases it via onLongPressEnd", () => {
    const s = spies();
    const { api } = renderHook(s);

    api.handleTouchStart(makeEvent(200, 400));
    advanceClock(500);

    expect(s.onLongPressStart).toHaveBeenCalledTimes(1);

    api.handleTouchCancel();

    expect(s.onLongPressEnd).toHaveBeenCalledTimes(1);
    expect(s.onTap).not.toHaveBeenCalled();

    // state is clean: a fresh gesture still long-presses
    api.handleTouchStart(makeEvent(200, 400));
    advanceClock(500);

    expect(s.onLongPressStart).toHaveBeenCalledTimes(2);
  });
});
