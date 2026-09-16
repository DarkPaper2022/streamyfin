/**
 * In-flight download tracking for the video cache: which native download
 * task belongs to which stream key, and which keys are currently being
 * downloaded.
 */

import type { VideoCacheEnqueueParams } from "./types";

/** An in-flight download and everything needed to record it when it lands. */
export interface InFlightTask extends VideoCacheEnqueueParams {
  streamKey: string;
  /** Bare absolute destination the download is writing to. */
  path: string;
}

const inFlightTasks = new Map<number, InFlightTask>();
const inFlightKeys = new Set<string>();

/** Mark a stream as in-flight before its download is started. */
export const markStart = (streamKey: string): void => {
  inFlightKeys.add(streamKey);
};

/** Remember which native task belongs to which stream. */
export const trackTask = (taskId: number, task: InFlightTask): void => {
  inFlightTasks.set(taskId, task);
};

/** Look up the in-flight task for a native task id. */
export const getTask = (taskId: number): InFlightTask | undefined =>
  inFlightTasks.get(taskId);

/** Whether a stream is currently being downloaded. */
export const isCaching = (streamKey: string | undefined): boolean =>
  streamKey !== undefined && inFlightKeys.has(streamKey);

/** Drop one task; the key leaves the set when no task references it. */
export const removeTask = (taskId: number, streamKey: string): void => {
  inFlightTasks.delete(taskId);
  if (!inFlightTasksHasKey(streamKey)) {
    inFlightKeys.delete(streamKey);
  }
};

/**
 * Cancel every in-flight task (optionally filtered) via `cancel`, removing
 * them from tracking. Completed entries live in the index, not here, so
 * this never touches finished downloads.
 */
export const cancelInFlightTasks = (
  cancel: (taskId: number) => void,
  predicate?: (task: InFlightTask) => boolean,
): number => {
  let cancelled = 0;
  for (const [taskId, task] of [...inFlightTasks.entries()]) {
    if (predicate && !predicate(task)) continue;
    cancel(taskId);
    inFlightTasks.delete(taskId);
    cancelled += 1;
  }
  for (const key of [...inFlightKeys]) {
    if (!inFlightTasksHasKey(key)) {
      inFlightKeys.delete(key);
    }
  }
  return cancelled;
};

/** Test-only: drop all in-flight tracking so each spec starts clean. */
export const clearInFlight = (): void => {
  inFlightTasks.clear();
  inFlightKeys.clear();
};

const inFlightTasksHasKey = (streamKey: string): boolean =>
  [...inFlightTasks.values()].some((task) => task.streamKey === streamKey);
