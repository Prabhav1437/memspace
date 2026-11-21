import type { Encoding } from "../core/encoding.js";
import type { OpenMode } from "../core/flags.js";
import type { PermissionMode } from "../engine/engine.js";

export type { Encoding } from "../core/encoding.js";
export type { OpenMode } from "../core/flags.js";
export type { PathLike } from "../core/path.js";
export type { PermissionMode } from "../engine/engine.js";

export type Mode = number | string;
export type TimeLike = number | string | Date;

/** Options accepted by `createFs()` / `new VirtualFileSystem()`. */
export interface MemspaceOptions {
  /** Label used in error messages and `getStats()`. Default: `"memspace-<n>"`. */
  name?: string;
  /** Maximum bytes of file content this instance may hold. Default: unlimited. */
  maxMemory?: number;
  /** Maximum number of nodes (files + directories + symlinks, including the root). Default: unlimited. */
  maxNodes?: number;
  /** Maximum simultaneously open descriptors. Default: 65536. */
  maxOpenFiles?: number;
  /** Initial working directory for relative paths (created if missing). Default: `"/"`. */
  cwd?: string;
  /** Owner reported for new nodes and used for permission checks. Default: the process uid, or 0. */
  uid?: number;
  /** Group reported for new nodes. Default: the process gid, or 0. */
  gid?: number;
  /** Mode bits cleared from newly created files and directories. Default: `0o022`. */
  umask?: number;
  /**
   * `"ignore"` (default): mode bits are stored and reported but never enforced,
   * like running as a privileged user. `"owner"`: classic owner/group/other bits
   * are enforced for traversal, reads, writes and directory changes.
   */
  permissions?: PermissionMode;
  /**
   * How expired TTL entries are reclaimed. Expired entries are never visible in
   * either mode. `"timer"` (default) also schedules an unref'd timer that frees
   * their memory promptly; `"lazy"` reclaims only on access or `purgeExpired()`.
   */
  ttlCleanup?: "timer" | "lazy";
}

/** Memspace extension accepted by `writeFile`/`appendFile`/`mkdir`: expire the entry after `ttl` ms. */
export interface TtlOption {
  /** Milliseconds until the entry expires and is removed. Memspace extension, not a native fs option. */
  ttl?: number;
}

export interface ReadFileOptions {
  encoding?: Encoding | null;
  flag?: OpenMode;
  signal?: AbortSignal;
}

export interface WriteFileOptions extends TtlOption {
  encoding?: Encoding | null;
  mode?: Mode;
  flag?: OpenMode;
  flush?: boolean;
  signal?: AbortSignal;
}

export interface MakeDirectoryOptions extends TtlOption {
  recursive?: boolean;
  mode?: Mode;
}

export interface ReaddirOptions {
  encoding?: Encoding | null;
  withFileTypes?: boolean;
  recursive?: boolean;
}

export interface StatOptions {
  bigint?: boolean;
  throwIfNoEntry?: boolean;
}

export interface RmOptions {
  recursive?: boolean;
  force?: boolean;
  /** Accepted for compatibility; retries are never needed in memory. */
  maxRetries?: number;
  /** Accepted for compatibility; ignored. */
  retryDelay?: number;
}

export interface RmDirOptions {
  /** Deprecated in Node; supported here as recursive removal. */
  recursive?: boolean;
  maxRetries?: number;
  retryDelay?: number;
}

export interface CopyOptions {
  recursive?: boolean;
  force?: boolean;
  errorOnExist?: boolean;
  dereference?: boolean;
  preserveTimestamps?: boolean;
  verbatimSymlinks?: boolean;
  mode?: number;
  filter?: (source: string, destination: string) => boolean;
}

export interface OpenDirOptions {
  encoding?: Encoding | null;
  bufferSize?: number;
  recursive?: boolean;
}

export interface ReadSyncOptions {
  offset?: number;
  length?: number;
  position?: number | bigint | null;
}

export interface ReadStreamOptions {
  flags?: OpenMode;
  encoding?: BufferEncoding | null;
  fd?: number;
  mode?: number;
  autoClose?: boolean;
  emitClose?: boolean;
  start?: number;
  end?: number;
  highWaterMark?: number;
  signal?: AbortSignal;
}

export interface WriteStreamOptions extends TtlOption {
  flags?: OpenMode;
  encoding?: BufferEncoding | null;
  fd?: number;
  mode?: number;
  autoClose?: boolean;
  emitClose?: boolean;
  start?: number;
  highWaterMark?: number;
  flush?: boolean;
  signal?: AbortSignal;
}

export interface WatchOptions {
  persistent?: boolean;
  recursive?: boolean;
  encoding?: Encoding | null;
  signal?: AbortSignal;
}

export interface WatchFileOptions {
  persistent?: boolean;
  interval?: number;
  bigint?: boolean;
}

export type NoParamCallback = (err: NodeJS.ErrnoException | null) => void;
export type Callback<T> = (err: NodeJS.ErrnoException | null, result: T) => void;
