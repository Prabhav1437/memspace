/**
 * Memspace — a Node.js-compatible, zero-disk, in-memory virtual filesystem.
 *
 * ```ts
 * import fs from "memspace-fs";                 // default, package-level instance
 * import { createFs } from "memspace-fs";       // independent instances
 * import { readFileSync } from "memspace-fs";   // functions bound to the default instance
 * ```
 */
import { VirtualFileSystem, type MemspaceStats, type SnapshotOptions } from "./api/vfs.js";
import type { MemspaceOptions } from "./api/types.js";

export { VirtualFileSystem };
export type { MemspaceStats, SnapshotOptions };
export type * from "./api/types.js";
export { FileHandle, type PromisesApi } from "./api/promises.js";
export { Dir } from "./api/dir.js";
export { FSWatcher, StatWatcher, type WatchListener, type StatsListener } from "./api/watch.js";
export { Stats, BigIntStats, Dirent } from "./metadata/stats.js";
export { ReadStream, WriteStream } from "./streams/streams.js";
export { constants } from "./core/constants.js";
export { isErrnoException, type MemspaceErrnoException, type MemspaceCodedError, type ErrnoCode } from "./errors/index.js";
export { SNAPSHOT_FORMAT, SNAPSHOT_VERSION, type MemspaceSnapshot, type SnapshotEntry } from "./snapshots/snapshot.js";
export type { MemoryStats } from "./engine/memory.js";

/** Create an independent, isolated in-memory filesystem. */
export function createFs(options?: MemspaceOptions): VirtualFileSystem {
  return new VirtualFileSystem(options);
}

/**
 * The package-level default instance. It is created on import, shares nothing
 * with instances made by `createFs()`, and lives for the life of the process
 * (call `fs.reset()` to empty it).
 */
const fs: VirtualFileSystem = new VirtualFileSystem({ name: "default" });
export default fs;

// Native-style named exports bound to the default instance, so
// `import { readFileSync } from "node:fs"` can become `from "memspace-fs"`.
export const {
  promises,
  access, accessSync, appendFile, appendFileSync, chmod, chmodSync, chown, chownSync,
  close, closeSync, copyFile, copyFileSync, cp, cpSync, createReadStream, createWriteStream,
  exists, existsSync, fchmod, fchmodSync, fchown, fchownSync, fdatasync, fdatasyncSync,
  fstat, fstatSync, fsync, fsyncSync, ftruncate, ftruncateSync, futimes, futimesSync,
  lchmod, lchmodSync, lchown, lchownSync, lstat, lstatSync, lutimes, lutimesSync,
  mkdir, mkdirSync, mkdtemp, mkdtempSync, open, openSync, opendir, opendirSync,
  read, readSync, readFile, readFileSync, readdir, readdirSync, readlink, readlinkSync,
  realpath, realpathSync, rename, renameSync, rm, rmSync, rmdir, rmdirSync,
  stat, statSync, symlink, symlinkSync, truncate, truncateSync, unlink, unlinkSync,
  unwatchFile, utimes, utimesSync, watch, watchFile, write, writeSync, writeFile, writeFileSync,
} = fs;
