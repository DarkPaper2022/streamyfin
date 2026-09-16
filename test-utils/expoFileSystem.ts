/**
 * In-memory test double for `expo-file-system` (SDK 57 class API), backed
 * by a plain map so specs can simulate the platform without touching disk:
 * `writeFile` stands in for the native downloader writing a finished
 * download, `deletePath` for the OS reclaiming the soft cache directory,
 * and `stat`/`info` return metadata stamped by a fake clock (file
 * timestamps are deterministic; `storedAt`-style entry timestamps come from
 * `Date.now()` and are controlled separately via `setSystemTime`).
 *
 * Faithful to the real platform's path split: `Paths` use the Android
 * single-slash `file:/` shape (from `Uri.fromFile().toString()`), joined
 * child paths carry no trailing slash (like the real `Paths.join`), and the
 * File/Directory API stays lenient — it accepts bare paths and any `file:`
 * slash form, exactly like the real one.
 *
 * The native boundaries are modeled where they actually live: the strict
 * destination check (the native downloader's Java `File(String)` only
 * accepts a bare absolute path) lives in the spec's `BackgroundDownloader`
 * mock, and the `File` class percent-DECODES its URI before any lookup —
 * on Android expo's File is `java.io.File(URI)`, whose `URI.getPath()`
 * decodes, while the record WRITES stay literal (`java.io.File(String)`
 * decodes nothing). That split is what makes a percent-escaped filename
 * unstat-able, the device B8-hit bug.
 *
 * Backs `mock.module("expo-file-system", () => ({ Paths, Directory, File }))`.
 * Test-only: never imported by app code.
 */

export type FakeFileInfo = {
  exists: boolean;
  uri: string;
  isDirectory: boolean;
  size: number;
  modificationTime: number;
  creationTime: number;
};

type FileRecord = {
  type: "file";
  content: string;
  size: number;
  createdAt: number;
  modifiedAt: number;
};

type DirRecord = { type: "dir" };

type FsRecord = FileRecord | DirRecord;

const BASE_TIME = 1_760_000_000_000;
const encoder = new TextEncoder();

const records = new Map<string, FsRecord>();
let clock = BASE_TIME;

/** Fake current time in ms; the only notion of "now" the double uses. */
export const fakeNow = (): number => clock;

/** Advances the fake clock used to stamp file metadata. */
export const advanceClock = (ms: number): void => {
  clock += ms;
};

/** Restores the fake clock to its base value. */
export const resetClock = (): void => {
  clock = BASE_TIME;
};

/** Drops every file and directory. Call from `beforeEach`. */
export const clearFakeFileSystem = (): void => {
  records.clear();
};

/**
 * Canonical key for a path or URI. The real platform emits `file:` in three
 * slash shapes (`file:/` on Android, `file://`, `file:///`) and also accepts
 * bare paths, so strip the scheme — and the authority slashes when present,
 * never the path's own root slash — then collapse duplicate slashes and drop
 * the trailing slash. Every shape of one location addresses the same record.
 */
const normalize = (uri: string): string =>
  uri
    .replace(/^file:(\/\/)?/, "")
    .replace(/\/{2,}/g, "/")
    .replace(/\/+$/, "");

/**
 * The java.io.File(URI) boundary: on Android expo's File is
 * `File(URI.create(uri.toString()))`, and `URI.getPath()` percent-decodes.
 * Every File lookup therefore resolves its URI the way Java does. An invalid
 * escape sequence stays raw (lenient) — the names in play are either
 * URI-safe or valid escapes.
 */
const resolveFileUri = (uri: string): string => {
  const normalized = normalize(uri);
  try {
    return decodeURIComponent(normalized);
  } catch {
    return normalized;
  }
};

/**
 * Joins URI parts the way the real SDK's `Paths.join` does: at most one
 * slash between parts. A trailing slash survives only when the caller passed
 * it — the native `Paths` constants carry one, a joined child path does not
 * (the same split as on device).
 */
const joinUriParts = (...uris: (string | File | Directory)[]): string => {
  let joined = "";
  for (const part of uris) {
    const segment = typeof part === "string" ? part : part.uri;
    if (!joined) {
      joined = segment;
    } else if (!joined.endsWith("/") && !segment.startsWith("/")) {
      joined = `${joined}/${segment}`;
    } else {
      joined += segment;
    }
  }
  return joined;
};

const dirExists = (path: string): boolean => records.get(path)?.type === "dir";

const fileRecord = (path: string): FileRecord | undefined => {
  const record = records.get(path);
  return record?.type === "file" ? record : undefined;
};

/** Creates the directory and any missing parents. */
export const makeDir = (uri: string): void => {
  const parts = normalize(uri).split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    current = `${current}/${part}`;
    if (!records.has(current)) {
      records.set(current, { type: "dir" });
    }
  }
};

/** Writes a file, creating parent directories as needed. */
export const writeFile = (uri: string, content: string): void => {
  const path = normalize(uri);
  const parent = path.slice(0, path.lastIndexOf("/"));
  if (parent && !dirExists(parent)) {
    makeDir(`${parent}/`);
  }
  records.set(path, {
    type: "file",
    content,
    size: encoder.encode(content).length,
    createdAt: clock,
    modifiedAt: clock,
  });
};

/** Reads a file's text content; throws `ENOENT` when it is missing. */
export const readFile = (uri: string): string => {
  const record = fileRecord(normalize(uri));
  if (!record) {
    throw new Error(`ENOENT: no such file: ${uri}`);
  }
  return record.content;
};

/** Deletes a file, or a directory and everything inside it. Idempotent. */
export const deletePath = (uri: string): void => {
  const path = normalize(uri);
  const record = records.get(path);
  if (!record) return;
  if (record.type === "dir") {
    for (const key of [...records.keys()]) {
      if (key === path || key.startsWith(`${path}/`)) {
        records.delete(key);
      }
    }
  } else {
    records.delete(path);
  }
};

/** Metadata for a file or directory, or `null` when the path is missing. */
export const stat = (uri: string): FakeFileInfo | null => {
  const record = records.get(normalize(uri));
  if (!record) return null;
  const isDir = record.type === "dir";
  return {
    exists: true,
    uri,
    isDirectory: isDir,
    size: isDir ? 0 : record.size,
    modificationTime: isDir ? 0 : record.modifiedAt,
    creationTime: isDir ? 0 : record.createdAt,
  };
};

/** Like `stat` but throws `ENOENT` for missing paths. */
export const info = (uri: string): FakeFileInfo => {
  const result = stat(uri);
  if (!result) {
    throw new Error(`ENOENT: no such file: ${uri}`);
  }
  return result;
};

/** Moves a file or directory; the source must exist. */
export const move = (from: string, to: string): void => {
  const fromPath = normalize(from);
  const record = records.get(fromPath);
  if (!record) {
    throw new Error(`ENOENT: no such file: ${from}`);
  }
  records.delete(fromPath);
  records.set(normalize(to), record);
};

/** Copies a file or directory; the source must exist. */
export const copy = (from: string, to: string): void => {
  const fromPath = normalize(from);
  if (!records.has(fromPath)) {
    throw new Error(`ENOENT: no such file: ${from}`);
  }
  const toPath = normalize(to);
  for (const [key, record] of [...records]) {
    if (key === fromPath || key.startsWith(`${fromPath}/`)) {
      records.set(`${toPath}${key.slice(fromPath.length)}`, { ...record });
    }
  }
};

export class File {
  readonly uri: string;

  constructor(...uris: (string | File | Directory)[]) {
    this.uri = joinUriParts(...uris);
  }

  /**
   * The path this File resolves to: `java.io.File(URI)` percent-decodes, so
   * every operation on the instance sees the decoded path, while records are
   * keyed by the literal name the native writer stored.
   */
  private get path(): string {
    return resolveFileUri(this.uri);
  }

  get exists(): boolean {
    return fileRecord(this.path) !== undefined;
  }

  get size(): number {
    return fileRecord(this.path)?.size ?? 0;
  }

  create(): void {
    writeFile(this.path, "");
  }

  delete(): void {
    deletePath(this.path);
  }

  info(): FakeFileInfo {
    const result = stat(this.path);
    if (!result || result.isDirectory) {
      throw new Error(`ENOENT: not a file: ${this.uri}`);
    }
    return result;
  }

  write(content: string): void {
    writeFile(this.path, content);
  }

  readAsString(): string {
    return readFile(this.path);
  }

  move(destination: File | Directory): void {
    move(
      this.path,
      destination instanceof File
        ? resolveFileUri(destination.uri)
        : destination.uri,
    );
  }

  copy(destination: File | Directory): void {
    copy(
      this.path,
      destination instanceof File
        ? resolveFileUri(destination.uri)
        : destination.uri,
    );
  }
}

export class Directory {
  readonly uri: string;

  constructor(...uris: (string | File | Directory)[]) {
    this.uri = joinUriParts(...uris);
  }

  get exists(): boolean {
    return dirExists(normalize(this.uri));
  }

  get name(): string {
    const path = normalize(this.uri);
    return path.slice(path.lastIndexOf("/") + 1);
  }

  create(): void {
    makeDir(this.uri);
  }

  delete(): void {
    deletePath(this.uri);
  }

  info(): FakeFileInfo {
    const result = stat(this.uri);
    if (!result?.isDirectory) {
      throw new Error(`ENOENT: not a directory: ${this.uri}`);
    }
    return result;
  }

  createFile(name: string): File {
    return new File(this, name);
  }

  createDirectory(name: string): Directory {
    return new Directory(this, name);
  }
}

/**
 * Stand-ins for `Paths.cache` / `Paths.document`. Fixed roots keep
 * assertions readable; the real roots vary per device and OS. The single-
 * slash `file:/` shape mirrors Android's `Uri.fromFile().toString()` (the
 * real SDK 57 emits it, not `file:///`).
 */
export const Paths = {
  cache: new Directory("file:/cache/"),
  document: new Directory("file:/documents/"),
  bundle: new Directory("file:/bundle/"),
} as const;
