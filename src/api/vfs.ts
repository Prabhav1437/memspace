/**
 * VirtualFileSystem: the public, `fs`-compatible face of a Memspace instance.
 *
 * Synchronous methods call straight into the engine. Callback methods run the
 * same synchronous operation immediately (so it is atomic and ordered with
 * respect to every other call) and deliver the result on a later tick, as Node
 * does; argument-validation errors are thrown synchronously, exactly like
 * Node's. The promise API (`fs.promises`) lives in ./promises.ts.
 *
 * Every method is bound to its instance, so `const { readFileSync } = fs` works.
 */
import { posix } from "node:path";
import { randomBytes } from "node:crypto";
import {
  COPYFILE_EXCL,
  COPYFILE_FICLONE_FORCE,
  DEFAULT_DIR_MODE,
  DEFAULT_FILE_MODE,
  DEFAULT_UMASK,
  F_OK,
  constants,
} from "../core/constants.js";
import { decode, encodeName, normalizeOptions, toBuffer, type Encoding, type WriteData } from "../core/encoding.js";
import { parseFlags, type OpenMode } from "../core/flags.js";
import type { FileNode, FsNode } from "../core/nodes.js";
import { pathToString, type PathLike } from "../core/path.js";
import { FdTable, type OpenFile } from "../descriptors/fd-table.js";
import { FsEngine } from "../engine/engine.js";
import type { MemoryStats } from "../engine/memory.js";
import {
  codedError,
  disposedError,
  errnoError,
  invalidArgType,
  outOfRange,
  type MemspaceCodedError,
} from "../errors/index.js";
import { TtlManager } from "../lifecycle/ttl.js";
import { BigIntStats, Dirent, Stats } from "../metadata/stats.js";
import {
  collectEntries,
  decodeSnapshot,
  toBinarySnapshot,
  toJsonSnapshot,
  type MemspaceSnapshot,
} from "../snapshots/snapshot.js";
import { ReadStream, WriteStream, type StreamHost } from "../streams/streams.js";
import { Dir } from "./dir.js";
import { createPromisesApi, type PromisesApi } from "./promises.js";
import type {
  Callback,
  CopyOptions,
  MakeDirectoryOptions,
  MemspaceOptions,
  Mode,
  NoParamCallback,
  OpenDirOptions,
  ReadFileOptions,
  ReaddirOptions,
  ReadStreamOptions,
  ReadSyncOptions,
  RmDirOptions,
  RmOptions,
  StatOptions,
  TimeLike,
  WatchFileOptions,
  WatchOptions,
  WriteFileOptions,
  WriteStreamOptions,
} from "./types.js";
import { FSWatcher, StatWatcher, WatchRegistry, type StatsListener, type WatchListener } from "./watch.js";

/** Statistics returned by `getStats()`. */
export interface MemspaceStats extends MemoryStats {
  name: string;
  openFileDescriptors: number;
  watcherCount: number;
  disposed: boolean;
}

export interface SnapshotOptions {
  /** `"json"` (default) returns a JSON-compatible object; `"binary"` returns a compact Buffer. */
  format?: "json" | "binary";
}

type AnyStats = Stats | BigIntStats;
type ReaddirResult = string[] | Buffer[] | Dirent<string>[] | Dirent<Buffer>[];

let instanceCounter = 0;

// ------------------------------------------------------------------ helpers

function validateFd(fd: unknown): number {
  if (typeof fd !== "number") throw invalidArgType("fd", "of type number", fd);
  if (!Number.isInteger(fd) || fd < 0 || fd > 0x7fffffff) throw outOfRange("fd", ">= 0 && <= 2147483647", fd);
  return fd;
}

function parseMode(mode: Mode | undefined | null, fallback: number, name = "mode"): number {
  if (mode === undefined || mode === null) return fallback;
  if (typeof mode === "string") {
    if (!/^[0-7]+$/.test(mode)) throw codedError("ERR_INVALID_ARG_VALUE", `The argument '${name}' must be a 32-bit unsigned integer or an octal string. Received '${mode}'`, TypeError);
    return parseInt(mode, 8);
  }
  if (typeof mode !== "number") throw invalidArgType(name, "of type number", mode);
  if (!Number.isInteger(mode) || mode < 0 || mode > 0xffffffff) throw outOfRange(name, ">= 0 && <= 4294967295", mode);
  return mode;
}

function toTimeMs(time: TimeLike, name: string): number {
  if (time instanceof Date) return time.getTime();
  if (typeof time === "string" && time.trim() !== "" && Number.isFinite(Number(time))) return Number(time) * 1000;
  if (typeof time === "number") return Number.isFinite(time) ? time * 1000 : Date.now();
  throw invalidArgType(name, "of type number or an instance of Date", time);
}

function validateTtl(ttl: unknown): number | undefined {
  if (ttl === undefined) return undefined;
  if (typeof ttl !== "number" || !Number.isFinite(ttl) || ttl < 0) {
    throw outOfRange("ttl", "a finite number >= 0 (milliseconds)", ttl);
  }
  return ttl;
}

function validateLength(len: unknown, name = "len"): number {
  if (len === undefined || len === null) return 0;
  if (typeof len !== "number") throw invalidArgType(name, "of type number", len);
  if (!Number.isInteger(len)) throw outOfRange(name, "an integer", len);
  return Math.max(0, len);
}

function toPosition(position: unknown): number | null {
  if (position === undefined || position === null) return null;
  if (typeof position === "bigint") {
    if (position < -1n) throw outOfRange("position", ">= -1", position);
    return position === -1n ? null : Number(position);
  }
  if (typeof position !== "number") throw invalidArgType("position", "of type number or bigint", position);
  if (!Number.isInteger(position)) throw outOfRange("position", "an integer", position);
  if (position === -1) return null;
  if (position < -1) throw outOfRange("position", ">= -1", position);
  return position;
}

function isAsyncError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  return "syscall" in error || code === "ERR_MEMSPACE_DISPOSED" || code === "ERR_MEMSPACE_INVALID_SNAPSHOT"
    || (typeof code === "string" && code.startsWith("ERR_FS_"));
}

function takeCallback(args: unknown[]): (...values: unknown[]) => void {
  const callback = args.pop();
  if (typeof callback !== "function") throw invalidArgType("cb", "of type function", callback);
  return callback as (...values: unknown[]) => void;
}

/** Node's `SystemError [ERR_FS_EISDIR]` raised by rm()/cp() on a directory without `recursive`. */
function fsEisdir(syscall: string | undefined, path: string, message: string): MemspaceCodedError {
  const error = codedError("ERR_FS_EISDIR", message) as MemspaceCodedError & Record<string, unknown>;
  error.name = "SystemError";
  error.errno = 21;
  if (syscall !== undefined) error.syscall = syscall;
  error.path = path;
  return error;
}

const RANDOM_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

// --------------------------------------------------------------------- class

export class VirtualFileSystem implements StreamHost {
  /** Instance label. */
  readonly name: string;
  readonly constants = constants;
  readonly Stats = Stats;
  readonly BigIntStats = BigIntStats;
  readonly Dirent = Dirent;
  readonly Dir = Dir;
  readonly ReadStream = ReadStream;
  readonly WriteStream = WriteStream;
  readonly F_OK = constants.F_OK;
  readonly R_OK = constants.R_OK;
  readonly W_OK = constants.W_OK;
  readonly X_OK = constants.X_OK;

  /** `realpathSync` with the `.native` alias (identical in memory). */
  readonly realpathSync: {
    (path: PathLike, options?: { encoding?: Encoding | null } | Encoding | null): string;
    (path: PathLike, options: { encoding: "buffer" } | "buffer"): Buffer;
    native(path: PathLike, options?: { encoding?: Encoding | null } | Encoding | null): string | Buffer;
  };
  /** Callback `realpath` with the `.native` alias. */
  readonly realpath: {
    (path: PathLike, callback: Callback<string>): void;
    (path: PathLike, options: { encoding?: Encoding | null } | Encoding | null | undefined, callback: Callback<string | Buffer>): void;
    native(path: PathLike, ...args: unknown[]): void;
  };

  #engine: FsEngine;
  #fds: FdTable;
  #watchers: WatchRegistry;
  #ttl: TtlManager;
  #promises: PromisesApi | undefined;
  #disposed = false;

  constructor(options: MemspaceOptions = {}) {
    const maxMemory = options.maxMemory ?? Infinity;
    if (typeof maxMemory !== "number" || Number.isNaN(maxMemory) || maxMemory < 0) {
      throw outOfRange("maxMemory", "a number >= 0", maxMemory);
    }
    const maxNodes = options.maxNodes ?? Infinity;
    if (typeof maxNodes !== "number" || Number.isNaN(maxNodes) || maxNodes < 1) {
      throw outOfRange("maxNodes", "a number >= 1", maxNodes);
    }
    this.name = options.name ?? `memspace-${++instanceCounter}`;
    this.#engine = new FsEngine({
      maxMemory,
      maxNodes,
      cwd: options.cwd ?? "/",
      uid: options.uid ?? process.getuid?.() ?? 0,
      gid: options.gid ?? process.getgid?.() ?? 0,
      umask: options.umask ?? DEFAULT_UMASK,
      permissions: options.permissions ?? "ignore",
    });
    this.#fds = new FdTable(options.maxOpenFiles ?? 65536);
    this.#watchers = new WatchRegistry(this.#engine);
    this.#ttl = new TtlManager(this.#engine, options.ttlCleanup ?? "timer");

    const realpathSync = (path: PathLike, opts?: { encoding?: Encoding | null } | Encoding | null) => {
      this.#guard();
      const { encoding } = normalizeOptions(opts, {});
      return encodeName(this.#engine.realpath(pathToString(path)), encoding);
    };
    this.realpathSync = Object.assign(realpathSync, { native: realpathSync }) as VirtualFileSystem["realpathSync"];
    const realpath = (path: PathLike, ...rest: unknown[]) => {
      const callback = takeCallback(rest);
      this.#deliver(callback, () => realpathSync(path, rest[0] as Encoding | undefined));
    };
    this.realpath = Object.assign(realpath, { native: realpath }) as VirtualFileSystem["realpath"];

    this.#bindMethods();
  }

  /** Bind every prototype method so destructuring works, guarding against use after dispose. */
  #bindMethods(): void {
    const exempt = new Set(["constructor", "dispose", "isDisposed", "getStats"]);
    const self = this as unknown as Record<string, unknown>;
    for (const key of Object.getOwnPropertyNames(VirtualFileSystem.prototype)) {
      if (exempt.has(key)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(VirtualFileSystem.prototype, key);
      if (!descriptor || typeof descriptor.value !== "function") continue;
      const method = descriptor.value as (...args: unknown[]) => unknown;
      Object.defineProperty(this, key, {
        value: (...args: unknown[]) => {
          if (this.#disposed) throw disposedError(this.name);
          return method.apply(this, args);
        },
        writable: true,
        configurable: true,
        enumerable: false,
      });
    }
    void self;
  }

  #guard(): void {
    if (this.#disposed) throw disposedError(this.name);
  }

  /** Run `op` now; deliver its result (or errno error) to `callback` on a later tick. */
  #deliver<T>(
    callback: (...values: unknown[]) => void,
    op: () => T,
    spread: (result: T) => unknown[] = (result) => (result === undefined ? [null] : [null, result]),
  ): void {
    let result: T;
    try {
      result = op();
    } catch (error) {
      if (!isAsyncError(error)) throw error;
      process.nextTick(callback, error);
      return;
    }
    process.nextTick(() => callback(...spread(result)));
  }

  /** Promise-based API mirroring `fs.promises`. */
  get promises(): PromisesApi {
    this.#guard();
    this.#promises ??= createPromisesApi(this);
    return this.#promises;
  }

  // ============================================================ open files

  #openFile(fd: number, syscall: string): OpenFile {
    return this.#fds.get(validateFd(fd), syscall);
  }

  #regularFile(file: OpenFile, syscall: string): FileNode {
    if (file.node.type !== "file") throw errnoError("EISDIR", { syscall });
    return file.node;
  }

  openSync(path: PathLike, flags: OpenMode = "r", mode: Mode = DEFAULT_FILE_MODE): number {
    const input = pathToString(path);
    const parsed = parseFlags(flags);
    const node = this.#engine.open(input, parsed, parseMode(mode, DEFAULT_FILE_MODE));
    const file = this.#fds.add({ node, flags: parsed, position: 0, path: this.#engine.pathOf(node) }, "open", input);
    node.openCount++;
    return file.fd;
  }

  closeSync(fd: number): void {
    const file = this.#openFile(fd, "close");
    this.#fds.delete(file.fd);
    this.#engine.closeNode(file.node);
  }

  readSync(fd: number, buffer: NodeJS.ArrayBufferView, offset?: number, length?: number, position?: number | bigint | null): number;
  readSync(fd: number, buffer: NodeJS.ArrayBufferView, options?: ReadSyncOptions): number;
  readSync(
    fd: number,
    buffer: NodeJS.ArrayBufferView,
    offsetOrOptions?: number | ReadSyncOptions,
    lengthArg?: number,
    positionArg?: number | bigint | null,
  ): number {
    const file = this.#openFile(fd, "read");
    if (!ArrayBuffer.isView(buffer)) throw invalidArgType("buffer", "an instance of Buffer, TypedArray, or DataView", buffer);
    let offset: number | undefined;
    let length: number | undefined;
    let position: unknown;
    if (typeof offsetOrOptions === "object" && offsetOrOptions !== null) {
      ({ offset, length, position } = offsetOrOptions);
    } else {
      offset = offsetOrOptions;
      length = lengthArg;
      position = positionArg;
    }
    offset ??= 0;
    if (typeof offset !== "number" || !Number.isInteger(offset)) throw invalidArgType("offset", "of type number", offset);
    if (offset < 0 || offset > buffer.byteLength) throw outOfRange("offset", `>= 0 && <= ${buffer.byteLength}`, offset);
    length ??= buffer.byteLength - offset;
    if (typeof length !== "number" || !Number.isInteger(length)) throw invalidArgType("length", "of type number", length);
    if (length < 0 || offset + length > buffer.byteLength) {
      throw outOfRange("length", `>= 0 && <= ${buffer.byteLength - offset}`, length);
    }
    const pos = toPosition(position);
    if (length === 0) return 0;
    if (!file.flags.readable) throw errnoError("EBADF", { syscall: "read" });
    const node = this.#regularFile(file, "read");
    const view = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const count = this.#engine.readAt(node, view, offset, length, pos ?? file.position);
    if (pos === null) file.position += count;
    return count;
  }

  writeSync(fd: number, buffer: NodeJS.ArrayBufferView, offset?: number | null, length?: number | null, position?: number | null): number;
  writeSync(fd: number, buffer: NodeJS.ArrayBufferView, options?: { offset?: number; length?: number; position?: number | null }): number;
  writeSync(fd: number, string: string, position?: number | null, encoding?: BufferEncoding | null): number;
  writeSync(fd: number, data: WriteData, a?: unknown, b?: unknown, c?: unknown): number {
    const file = this.#openFile(fd, "write");
    let bytes: Buffer;
    let position: number | null;
    if (typeof data === "string") {
      position = toPosition(a);
      bytes = toBuffer(data, (b as BufferEncoding | null | undefined) ?? "utf8", "buffer");
    } else {
      if (!ArrayBuffer.isView(data)) throw invalidArgType("buffer", "of type string or an instance of Buffer, TypedArray, or DataView", data);
      const whole = toBuffer(data, null, "buffer");
      let offset: unknown = a;
      let length: unknown = b;
      let pos: unknown = c;
      if (typeof a === "object" && a !== null) ({ offset, length, position: pos } = a as ReadSyncOptions);
      const off = offset === undefined || offset === null ? 0 : offset;
      if (typeof off !== "number" || !Number.isInteger(off)) throw invalidArgType("offset", "of type number", off);
      if (off < 0 || off > whole.byteLength) throw outOfRange("offset", `>= 0 && <= ${whole.byteLength}`, off);
      const len = length === undefined || length === null ? whole.byteLength - off : length;
      if (typeof len !== "number" || !Number.isInteger(len)) throw invalidArgType("length", "of type number", len);
      if (len < 0 || off + len > whole.byteLength) throw outOfRange("length", `>= 0 && <= ${whole.byteLength - off}`, len);
      bytes = whole.subarray(off, off + len);
      position = toPosition(pos);
    }
    if (!file.flags.writable) throw errnoError("EBADF", { syscall: "write" });
    const node = this.#regularFile(file, "write");
    if (file.flags.append) {
      // Linux semantics: with O_APPEND every write goes to the end, explicit positions are ignored.
      const written = this.#engine.writeAt(node, bytes, null, "write");
      file.position = node.size;
      return written;
    }
    const written = this.#engine.writeAt(node, bytes, position ?? file.position, "write");
    if (position === null) file.position += written;
    return written;
  }

  fstatSync(fd: number, options?: { bigint?: false }): Stats;
  fstatSync(fd: number, options: { bigint: true }): BigIntStats;
  fstatSync(fd: number, options?: { bigint?: boolean }): AnyStats {
    const file = this.#openFile(fd, "fstat");
    return options?.bigint ? new BigIntStats(file.node) : new Stats(file.node);
  }

  ftruncateSync(fd: number, len?: number): void {
    const file = this.#openFile(fd, "ftruncate");
    const length = validateLength(len);
    if (!file.flags.writable || file.node.type !== "file") throw errnoError("EINVAL", { syscall: "ftruncate" });
    this.#engine.truncateFile(file.node, length, "ftruncate");
  }

  /** Validates the descriptor; data is always "durable" in memory. */
  fsyncSync(fd: number): void {
    this.#openFile(fd, "fsync");
  }

  /** Validates the descriptor; data is always "durable" in memory. */
  fdatasyncSync(fd: number): void {
    this.#openFile(fd, "fdatasync");
  }

  fchmodSync(fd: number, mode: Mode): void {
    const file = this.#openFile(fd, "fchmod");
    this.#engine.chmod(file.node, parseMode(mode, 0));
  }

  fchownSync(fd: number, uid: number, gid: number): void {
    const file = this.#openFile(fd, "fchown");
    this.#engine.chown(file.node, uid, gid);
  }

  futimesSync(fd: number, atime: TimeLike, mtime: TimeLike): void {
    const file = this.#openFile(fd, "futime");
    this.#engine.utimes(file.node, toTimeMs(atime, "atime"), toTimeMs(mtime, "mtime"));
  }

  /** @internal Used by write streams for the `ttl` option. */
  applyTtlToDescriptor(fd: number, ttl: number): void {
    const file = this.#openFile(fd, "open");
    this.#engine.setTtl(file.node, validateTtl(ttl) ?? null);
  }

  // ======================================================== whole-file I/O

  readFileSync(path: PathLike | number, options?: { encoding?: null; flag?: OpenMode } | null): Buffer;
  readFileSync(path: PathLike | number, options: { encoding: BufferEncoding; flag?: OpenMode } | BufferEncoding): string;
  readFileSync(path: PathLike | number, options?: ReadFileOptions | Encoding | null): string | Buffer;
  readFileSync(path: PathLike | number, options?: ReadFileOptions | Encoding | null): string | Buffer {
    const opts = normalizeOptions<ReadFileOptions>(options, { flag: "r" });
    if (typeof path === "number") {
      const file = this.#openFile(path, "read");
      if (!file.flags.readable) throw errnoError("EBADF", { syscall: "read" });
      const node = this.#regularFile(file, "read");
      const start = Math.min(file.position, node.size);
      const bytes = Buffer.from(this.#engine.readContent(node).subarray(start));
      file.position = node.size;
      return decode(bytes, opts.encoding);
    }
    const input = pathToString(path);
    const flags = parseFlags(opts.flag);
    const node = this.#engine.open(input, flags, DEFAULT_FILE_MODE);
    if (node.type !== "file") throw errnoError("EISDIR", { syscall: "read" });
    return decode(this.#engine.readContent(node), opts.encoding);
  }

  writeFileSync(file: PathLike | number, data: WriteData, options?: WriteFileOptions | Encoding | null): void {
    this.#writeWhole(file, data, options, "w");
  }

  appendFileSync(file: PathLike | number, data: WriteData, options?: WriteFileOptions | Encoding | null): void {
    this.#writeWhole(file, data, options, "a");
  }

  #writeWhole(file: PathLike | number, data: WriteData, options: WriteFileOptions | Encoding | null | undefined, defaultFlag: string): void {
    const opts = normalizeOptions<WriteFileOptions>(options, { flag: defaultFlag });
    const ttl = validateTtl(opts.ttl);
    const bytes = toBuffer(data, opts.encoding ?? "utf8");
    if (typeof file === "number") {
      const fd = file;
      this.writeSync(fd, bytes, 0, bytes.byteLength, null);
      if (ttl !== undefined) this.applyTtlToDescriptor(fd, ttl);
      return;
    }
    const input = pathToString(file, "file");
    const flags = parseFlags(opts.flag);
    // Open without truncating so a write rejected by the memory limit leaves the old content intact.
    const node = this.#engine.open(input, { ...flags, truncate: false }, parseMode(opts.mode, DEFAULT_FILE_MODE), "open");
    if (node.type !== "file") throw errnoError("EISDIR", { syscall: "open", path: input });
    if (!flags.writable) throw errnoError("EBADF", { syscall: "write" });
    if (flags.append) this.#engine.writeAt(node, bytes, null, "write", input);
    else if (flags.truncate) this.#engine.replaceContent(node, bytes, "write", input);
    else this.#engine.writeAt(node, bytes, 0, "write", input);
    if (ttl !== undefined) this.#engine.setTtl(node, ttl);
  }

  truncateSync(path: PathLike | number, len?: number): void {
    if (typeof path === "number") return this.ftruncateSync(path, len);
    const input = pathToString(path);
    const length = validateLength(len);
    const node = this.#engine.open(input, parseFlags("r+"), DEFAULT_FILE_MODE, "open");
    if (node.type !== "file") throw errnoError("EISDIR", { syscall: "open", path: input });
    this.#engine.truncateFile(node, length, "ftruncate", input);
  }

  copyFileSync(src: PathLike, dest: PathLike, mode = 0): void {
    if (typeof mode !== "number" || !Number.isInteger(mode) || mode < 0 || mode > 7) throw outOfRange("mode", ">= 0 && <= 7", mode);
    const from = pathToString(src, "src");
    const to = pathToString(dest, "dest");
    if (mode & COPYFILE_FICLONE_FORCE) {
      throw errnoError("ENOTSUP", { syscall: "copyfile", path: from, dest: to, detail: "copy-on-write clones are not supported by memspace" });
    }
    this.#engine.copyFile(from, to, (mode & COPYFILE_EXCL) !== 0);
  }

  cpSync(src: PathLike, dest: PathLike, options: CopyOptions = {}): void {
    const from = pathToString(src, "src");
    const to = pathToString(dest, "dest");
    const opts = { force: true, errorOnExist: false, recursive: false, dereference: false, preserveTimestamps: false, ...options };
    const absFrom = posix.resolve(this.#engine.cwd, from);
    const absTo = posix.resolve(this.#engine.cwd, to);
    if (absFrom === absTo || absTo.startsWith(`${absFrom}/`)) {
      const error = codedError("ERR_FS_CP_EINVAL", `Invalid src or dest: cp returned EINVAL (cannot copy ${from} to a subdirectory of self ${to}) ${to}`);
      throw Object.assign(error, { syscall: "cp", path: to, errno: 22 });
    }
    this.#copyEntry(absFrom, absTo, opts);
  }

  #copyEntry(from: string, to: string, opts: Required<Pick<CopyOptions, "force" | "errorOnExist" | "recursive" | "dereference" | "preserveTimestamps">> & CopyOptions): void {
    if (opts.filter && !opts.filter(from, to)) return;
    const source = this.#engine.lookup(from, "cp", opts.dereference);
    const existing = this.#engine.locate(to, "cp", true).node;
    if (source.type === "directory") {
      if (!opts.recursive) throw fsEisdir(undefined, from, `Recursive option not enabled, cannot copy a directory: ${from}/`);
      if (existing && existing.type !== "directory") {
        throw Object.assign(codedError("ERR_FS_CP_DIR_TO_NON_DIR", `Cannot overwrite non-directory ${to} with directory ${from}`), { syscall: "cp", path: to });
      }
      if (!existing) this.#engine.mkdir(to, { mode: source.mode });
      for (const [name] of this.#engine.entries(source)) {
        this.#copyEntry(posix.join(from, name), posix.join(to, name), opts);
      }
    } else {
      if (existing?.type === "directory") {
        throw Object.assign(codedError("ERR_FS_CP_NON_DIR_TO_DIR", `Cannot overwrite directory ${to} with non-directory ${from}`), { syscall: "cp", path: to });
      }
      if (existing) {
        if (!opts.force) {
          if (opts.errorOnExist) throw Object.assign(codedError("ERR_FS_CP_EEXIST", `Target already exists: cp returned EEXIST (${to} already exists)`), { syscall: "cp", path: to, errno: 17 });
          return;
        }
        if (source.type === "symlink") this.#engine.unlink(to);
      }
      if (source.type === "symlink") this.#engine.symlink(source.target, to);
      else this.#engine.copyFile(from, to, ((opts.mode ?? 0) & COPYFILE_EXCL) !== 0);
    }
    if (opts.preserveTimestamps) {
      const target = this.#engine.lookup(to, "cp", false);
      this.#engine.utimes(target, source.atimeMs, source.mtimeMs);
    }
  }

  // =========================================================== directories

  mkdirSync(path: PathLike, options: MakeDirectoryOptions & { recursive: true }): string | undefined;
  mkdirSync(path: PathLike, options?: Mode | (MakeDirectoryOptions & { recursive?: false }) | null): undefined;
  mkdirSync(path: PathLike, options?: Mode | MakeDirectoryOptions | null): string | undefined;
  mkdirSync(path: PathLike, options?: Mode | MakeDirectoryOptions | null): string | undefined {
    const input = pathToString(path);
    const opts: MakeDirectoryOptions = typeof options === "object" && options !== null ? options : { mode: options ?? undefined };
    const ttl = validateTtl(opts.ttl);
    const mode = parseMode(opts.mode, DEFAULT_DIR_MODE);
    const first = this.#engine.mkdir(input, { recursive: opts.recursive === true, mode });
    if (ttl !== undefined && (first !== undefined || !opts.recursive)) {
      this.#engine.setTtl(this.#engine.lookup(input, "mkdir"), ttl);
    }
    return opts.recursive ? first : undefined;
  }

  mkdtempSync(prefix: string, options?: { encoding?: Encoding | null } | Encoding | null): string {
    const { encoding } = normalizeOptions(options, {});
    const base = pathToString(prefix, "prefix");
    for (let attempt = 0; attempt < 100; attempt++) {
      const suffix = Array.from(randomBytes(6), (byte) => RANDOM_CHARS[byte % RANDOM_CHARS.length]).join("");
      const candidate = `${base}${suffix}`;
      try {
        this.#engine.mkdir(candidate, { mode: 0o700 });
        return encodeName(candidate, encoding) as string;
      } catch (error) {
        if ((error as { code?: string }).code !== "EEXIST") {
          const e = error as { syscall?: string; path?: string; message: string };
          if (e.syscall === "mkdir") {
            e.syscall = "mkdtemp";
            e.path = `${base}XXXXXX`;
            e.message = e.message.replace(/, mkdir '.*'$/, `, mkdtemp '${base}XXXXXX'`);
          }
          throw error;
        }
      }
    }
    throw errnoError("EEXIST", { syscall: "mkdtemp", path: `${base}XXXXXX` });
  }

  readdirSync(path: PathLike, options?: { encoding?: BufferEncoding | null; withFileTypes?: false; recursive?: boolean } | BufferEncoding | null): string[];
  readdirSync(path: PathLike, options: { encoding: "buffer"; withFileTypes?: false; recursive?: boolean } | "buffer"): Buffer[];
  readdirSync(path: PathLike, options: { encoding?: BufferEncoding | null; withFileTypes: true; recursive?: boolean }): Dirent<string>[];
  readdirSync(path: PathLike, options: { encoding: "buffer"; withFileTypes: true; recursive?: boolean }): Dirent<Buffer>[];
  readdirSync(path: PathLike, options?: ReaddirOptions | Encoding | null): ReaddirResult;
  readdirSync(path: PathLike, options?: ReaddirOptions | Encoding | null): ReaddirResult {
    const input = pathToString(path);
    const opts = normalizeOptions<ReaddirOptions>(options, {});
    const results: Array<string | Buffer | Dirent<string | Buffer>> = [];
    const queue: Array<{ relative: string; entries: Array<[string, FsNode]> }> = [
      { relative: "", entries: this.#engine.readdir(input) },
    ];
    while (queue.length > 0) {
      const { relative, entries } = queue.shift()!;
      for (const [name, node] of entries) {
        const rel = relative ? `${relative}/${name}` : name;
        if (opts.withFileTypes) {
          const parentPath = relative ? posix.join(input, relative) : input;
          results.push(new Dirent(encodeName(name, opts.encoding), node.type, parentPath));
        } else {
          results.push(encodeName(rel, opts.encoding));
        }
        if (opts.recursive && node.type === "directory") {
          queue.push({ relative: rel, entries: this.#engine.entries(node) });
        }
      }
    }
    return results as ReaddirResult;
  }

  opendirSync(path: PathLike, options?: OpenDirOptions): Dir {
    const input = pathToString(path);
    const opts = normalizeOptions<OpenDirOptions>(options, {});
    const entries = this.readdirSync(input, {
      withFileTypes: true,
      recursive: opts.recursive ?? false,
      encoding: opts.encoding ?? null,
    } as ReaddirOptions) as Dirent<string | Buffer>[];
    return new Dir(input, entries);
  }

  rmdirSync(path: PathLike, options?: RmDirOptions): void {
    const input = pathToString(path);
    if (options?.recursive) {
      const outcome = this.#engine.rm(input, { recursive: true });
      if (outcome === "missing") throw errnoError("ENOENT", { syscall: "rmdir", path: input });
      return;
    }
    this.#engine.rmdir(input);
  }

  rmSync(path: PathLike, options?: RmOptions): void {
    const input = pathToString(path);
    const outcome = this.#engine.rm(input, { recursive: options?.recursive ?? false, force: options?.force ?? false });
    if (outcome === "directory") {
      throw fsEisdir("rm", input, `Path is a directory: rm returned EISDIR (is a directory) ${input}`);
    }
  }

  // ============================================================ namespace

  unlinkSync(path: PathLike): void {
    this.#engine.unlink(pathToString(path));
  }

  renameSync(oldPath: PathLike, newPath: PathLike): void {
    this.#engine.rename(pathToString(oldPath, "oldPath"), pathToString(newPath, "newPath"));
  }

  symlinkSync(target: PathLike, path: PathLike, _type?: "file" | "dir" | "junction" | null): void {
    const targetString = pathToString(target, "target");
    if (targetString === "") throw errnoError("ENOENT", { syscall: "symlink", path: targetString, dest: pathToString(path) });
    this.#engine.symlink(targetString, pathToString(path));
  }

  readlinkSync(path: PathLike, options?: { encoding?: BufferEncoding | null } | BufferEncoding | null): string;
  readlinkSync(path: PathLike, options: { encoding: "buffer" } | "buffer"): Buffer;
  readlinkSync(path: PathLike, options?: { encoding?: Encoding | null } | Encoding | null): string | Buffer;
  readlinkSync(path: PathLike, options?: { encoding?: Encoding | null } | Encoding | null): string | Buffer {
    const { encoding } = normalizeOptions(options, {});
    return encodeName(this.#engine.readlink(pathToString(path)), encoding);
  }

  // ============================================================= metadata

  statSync(path: PathLike, options?: StatOptions & { bigint?: false; throwIfNoEntry?: true }): Stats;
  statSync(path: PathLike, options: StatOptions & { bigint: true; throwIfNoEntry?: true }): BigIntStats;
  statSync(path: PathLike, options: StatOptions & { bigint?: false; throwIfNoEntry: false }): Stats | undefined;
  statSync(path: PathLike, options: StatOptions & { bigint: true; throwIfNoEntry: false }): BigIntStats | undefined;
  statSync(path: PathLike, options?: StatOptions): AnyStats | undefined;
  statSync(path: PathLike, options?: StatOptions): AnyStats | undefined {
    return this.#stat(path, options, true, "stat");
  }

  lstatSync(path: PathLike, options?: StatOptions & { bigint?: false; throwIfNoEntry?: true }): Stats;
  lstatSync(path: PathLike, options: StatOptions & { bigint: true; throwIfNoEntry?: true }): BigIntStats;
  lstatSync(path: PathLike, options: StatOptions & { bigint?: false; throwIfNoEntry: false }): Stats | undefined;
  lstatSync(path: PathLike, options: StatOptions & { bigint: true; throwIfNoEntry: false }): BigIntStats | undefined;
  lstatSync(path: PathLike, options?: StatOptions): AnyStats | undefined;
  lstatSync(path: PathLike, options?: StatOptions): AnyStats | undefined {
    return this.#stat(path, options, false, "lstat");
  }

  #stat(path: PathLike, options: StatOptions | undefined, follow: boolean, syscall: string): AnyStats | undefined {
    const input = pathToString(path);
    let node: FsNode;
    try {
      node = this.#engine.lookup(input, syscall, follow);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (options?.throwIfNoEntry === false && (code === "ENOENT" || code === "ENOTDIR")) return undefined;
      throw error;
    }
    return options?.bigint ? new BigIntStats(node) : new Stats(node);
  }

  existsSync(path: PathLike): boolean {
    try {
      this.#engine.lookup(pathToString(path), "access");
      return true;
    } catch {
      return false;
    }
  }

  accessSync(path: PathLike, mode: number = F_OK): void {
    if (typeof mode !== "number" || !Number.isInteger(mode) || mode < 0 || mode > 7) throw outOfRange("mode", ">= 0 && <= 7", mode);
    this.#engine.access(pathToString(path), mode);
  }

  chmodSync(path: PathLike, mode: Mode): void {
    const input = pathToString(path);
    this.#engine.chmod(this.#engine.lookup(input, "chmod"), parseMode(mode, 0));
  }

  lchmodSync(path: PathLike, mode: Mode): void {
    const input = pathToString(path);
    this.#engine.chmod(this.#engine.lookup(input, "lchmod", false), parseMode(mode, 0));
  }

  chownSync(path: PathLike, uid: number, gid: number): void {
    const input = pathToString(path);
    this.#engine.chown(this.#engine.lookup(input, "chown"), uid, gid);
  }

  lchownSync(path: PathLike, uid: number, gid: number): void {
    const input = pathToString(path);
    this.#engine.chown(this.#engine.lookup(input, "lchown", false), uid, gid);
  }

  utimesSync(path: PathLike, atime: TimeLike, mtime: TimeLike): void {
    const input = pathToString(path);
    this.#engine.utimes(this.#engine.lookup(input, "utime"), toTimeMs(atime, "atime"), toTimeMs(mtime, "mtime"));
  }

  lutimesSync(path: PathLike, atime: TimeLike, mtime: TimeLike): void {
    const input = pathToString(path);
    this.#engine.utimes(this.#engine.lookup(input, "lutime", false), toTimeMs(atime, "atime"), toTimeMs(mtime, "mtime"));
  }

  // ============================================================== streams

  createReadStream(path: PathLike | null, options?: ReadStreamOptions | BufferEncoding): ReadStream {
    const opts = typeof options === "string" ? { encoding: options } : { ...options };
    if (path === null && opts.fd === undefined) throw invalidArgType("path", "of type string or an instance of Buffer or URL", path);
    if (opts.fd !== undefined) validateFd(opts.fd);
    return new ReadStream(this, path === null ? undefined : pathToString(path), opts);
  }

  createWriteStream(path: PathLike | null, options?: WriteStreamOptions | BufferEncoding): WriteStream {
    const opts = typeof options === "string" ? { encoding: options } : { ...options };
    if (path === null && opts.fd === undefined) throw invalidArgType("path", "of type string or an instance of Buffer or URL", path);
    if (opts.fd !== undefined) validateFd(opts.fd);
    if (opts.ttl !== undefined) validateTtl(opts.ttl);
    return new WriteStream(this, path === null ? undefined : pathToString(path), opts);
  }

  // ============================================================= watchers

  watch(filename: PathLike, listener?: WatchListener): FSWatcher;
  watch(filename: PathLike, options: WatchOptions | Encoding | null | undefined, listener?: WatchListener): FSWatcher;
  watch(filename: PathLike, optionsOrListener?: WatchOptions | Encoding | null | WatchListener, maybeListener?: WatchListener): FSWatcher {
    const listener = typeof optionsOrListener === "function" ? optionsOrListener : maybeListener;
    const opts = normalizeOptions<WatchOptions>(typeof optionsOrListener === "function" ? undefined : optionsOrListener, {});
    const input = pathToString(filename, "filename");
    const node = this.#engine.lookup(input, "watch");
    const watcher = new FSWatcher(
      this.#watchers,
      this.#engine.pathOf(node),
      node.type === "directory",
      opts.recursive ?? false,
      opts.encoding,
      opts.signal,
    );
    if (listener) watcher.on("change", listener);
    return watcher;
  }

  watchFile(filename: PathLike, listener: StatsListener): StatWatcher;
  watchFile(filename: PathLike, options: WatchFileOptions | undefined, listener: StatsListener): StatWatcher;
  watchFile(filename: PathLike, optionsOrListener: WatchFileOptions | StatsListener | undefined, maybeListener?: StatsListener): StatWatcher {
    const listener = typeof optionsOrListener === "function" ? optionsOrListener : maybeListener;
    if (typeof listener !== "function") throw invalidArgType("listener", "of type function", listener);
    const options = typeof optionsOrListener === "object" ? optionsOrListener : {};
    const input = pathToString(filename, "filename");
    const absolute = posix.resolve(this.#engine.cwd, input);
    const statNow = (): AnyStats => {
      const node = this.#engine.locate(absolute, "stat", true).node;
      if (node) return options.bigint ? new BigIntStats(node) : new Stats(node);
      return zeroStats(options.bigint ?? false);
    };
    const watcher = this.#watchers.statWatcher(absolute, () => new StatWatcher(this.#watchers, absolute, () => {
      try {
        return statNow();
      } catch {
        return zeroStats(options.bigint ?? false);
      }
    }));
    watcher.on("change", listener);
    return watcher;
  }

  unwatchFile(filename: PathLike, listener?: StatsListener): void {
    const absolute = posix.resolve(this.#engine.cwd, pathToString(filename, "filename"));
    const watcher = this.#watchers.getStatWatcher(absolute);
    if (!watcher) return;
    if (listener) watcher.off("change", listener);
    else watcher.removeAllListeners("change");
    if (watcher.listenerCount("change") === 0) this.#watchers.dropStatWatcher(absolute);
  }

  // ===================================================== callback API

  readFile(path: PathLike | number, callback: Callback<Buffer>): void;
  readFile(path: PathLike | number, options: { encoding?: null; flag?: OpenMode } | null | undefined, callback: Callback<Buffer>): void;
  readFile(path: PathLike | number, options: { encoding: BufferEncoding; flag?: OpenMode } | BufferEncoding, callback: Callback<string>): void;
  readFile(path: PathLike | number, options: ReadFileOptions | Encoding | null | undefined, callback: Callback<string | Buffer>): void;
  readFile(path: PathLike | number, ...rest: unknown[]): void {
    const cb = takeCallback(rest);
    this.#deliver(cb, () => this.readFileSync(path, rest[0] as ReadFileOptions));
  }

  writeFile(file: PathLike | number, data: WriteData, callback: NoParamCallback): void;
  writeFile(file: PathLike | number, data: WriteData, options: WriteFileOptions | Encoding | null | undefined, callback: NoParamCallback): void;
  writeFile(file: PathLike | number, data: WriteData, ...rest: unknown[]): void {
    const cb = takeCallback(rest);
    this.#deliver(cb, () => this.writeFileSync(file, data, rest[0] as WriteFileOptions));
  }

  appendFile(file: PathLike | number, data: WriteData, callback: NoParamCallback): void;
  appendFile(file: PathLike | number, data: WriteData, options: WriteFileOptions | Encoding | null | undefined, callback: NoParamCallback): void;
  appendFile(file: PathLike | number, data: WriteData, ...rest: unknown[]): void {
    const cb = takeCallback(rest);
    this.#deliver(cb, () => this.appendFileSync(file, data, rest[0] as WriteFileOptions));
  }

  open(path: PathLike, callback: Callback<number>): void;
  open(path: PathLike, flags: OpenMode | undefined, callback: Callback<number>): void;
  open(path: PathLike, flags: OpenMode | undefined, mode: Mode | undefined | null, callback: Callback<number>): void;
  open(path: PathLike, ...rest: unknown[]): void {
    const cb = takeCallback(rest);
    this.#deliver(cb, () => this.openSync(path, (rest[0] as OpenMode) ?? "r", (rest[1] as Mode) ?? DEFAULT_FILE_MODE));
  }

  close(fd: number, callback: NoParamCallback = () => {}): void {
    this.#deliver(takeCallback([callback]), () => this.closeSync(fd));
  }

  read(fd: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number, position: number | bigint | null, callback: (err: NodeJS.ErrnoException | null, bytesRead: number, buffer: NodeJS.ArrayBufferView) => void): void;
  read(fd: number, options: ReadSyncOptions & { buffer?: NodeJS.ArrayBufferView }, callback: (err: NodeJS.ErrnoException | null, bytesRead: number, buffer: NodeJS.ArrayBufferView) => void): void;
  read(fd: number, buffer: NodeJS.ArrayBufferView, options: ReadSyncOptions, callback: (err: NodeJS.ErrnoException | null, bytesRead: number, buffer: NodeJS.ArrayBufferView) => void): void;
  read(fd: number, callback: (err: NodeJS.ErrnoException | null, bytesRead: number, buffer: Buffer) => void): void;
  read(fd: number, ...rest: unknown[]): void {
    const cb = takeCallback(rest);
    let buffer: NodeJS.ArrayBufferView;
    let options: ReadSyncOptions;
    if (rest.length === 0 || (rest.length === 1 && !ArrayBuffer.isView(rest[0]))) {
      const opts = (rest[0] ?? {}) as ReadSyncOptions & { buffer?: NodeJS.ArrayBufferView };
      buffer = opts.buffer ?? Buffer.alloc(16384);
      options = { offset: opts.offset ?? 0, length: opts.length ?? buffer.byteLength - (opts.offset ?? 0), position: opts.position ?? null };
    } else if (rest.length === 2 && typeof rest[1] === "object" && rest[1] !== null) {
      buffer = rest[0] as NodeJS.ArrayBufferView;
      options = rest[1] as ReadSyncOptions;
    } else {
      buffer = rest[0] as NodeJS.ArrayBufferView;
      options = { offset: rest[1] as number, length: rest[2] as number, position: rest[3] as number | null };
    }
    this.#deliver(cb, () => this.readSync(fd, buffer, options), (count) => [null, count, buffer]);
  }

  write(fd: number, buffer: NodeJS.ArrayBufferView, offset: number | null | undefined, length: number | null | undefined, position: number | null | undefined, callback: (err: NodeJS.ErrnoException | null, written: number, buffer: NodeJS.ArrayBufferView) => void): void;
  write(fd: number, buffer: NodeJS.ArrayBufferView, offset: number | null | undefined, length: number | null | undefined, callback: (err: NodeJS.ErrnoException | null, written: number, buffer: NodeJS.ArrayBufferView) => void): void;
  write(fd: number, buffer: NodeJS.ArrayBufferView, offset: number | null | undefined, callback: (err: NodeJS.ErrnoException | null, written: number, buffer: NodeJS.ArrayBufferView) => void): void;
  write(fd: number, buffer: NodeJS.ArrayBufferView, callback: (err: NodeJS.ErrnoException | null, written: number, buffer: NodeJS.ArrayBufferView) => void): void;
  write(fd: number, string: string, position: number | null | undefined, encoding: BufferEncoding | null | undefined, callback: (err: NodeJS.ErrnoException | null, written: number, str: string) => void): void;
  write(fd: number, string: string, position: number | null | undefined, callback: (err: NodeJS.ErrnoException | null, written: number, str: string) => void): void;
  write(fd: number, string: string, callback: (err: NodeJS.ErrnoException | null, written: number, str: string) => void): void;
  write(fd: number, data: WriteData, ...rest: unknown[]): void {
    const cb = takeCallback(rest);
    const run = typeof data === "string"
      ? () => this.writeSync(fd, data, rest[0] as number | null, rest[1] as BufferEncoding | null)
      : () => this.writeSync(fd, data, rest[0] as number | null, rest[1] as number | null, rest[2] as number | null);
    this.#deliver(cb, run, (written) => [null, written, data]);
  }

  fstat(fd: number, callback: Callback<Stats>): void;
  fstat(fd: number, options: { bigint?: boolean } | undefined, callback: Callback<AnyStats>): void;
  fstat(fd: number, ...rest: unknown[]): void {
    const cb = takeCallback(rest);
    this.#deliver(cb, () => this.fstatSync(fd, rest[0] as { bigint?: false }));
  }

  ftruncate(fd: number, callback: NoParamCallback): void;
  ftruncate(fd: number, len: number | undefined | null, callback: NoParamCallback): void;
  ftruncate(fd: number, ...rest: unknown[]): void {
    const cb = takeCallback(rest);
    this.#deliver(cb, () => this.ftruncateSync(fd, rest[0] as number));
  }

  fsync(fd: number, callback: NoParamCallback): void {
    this.#deliver(takeCallback([callback]), () => this.fsyncSync(fd));
  }

  fdatasync(fd: number, callback: NoParamCallback): void {
    this.#deliver(takeCallback([callback]), () => this.fdatasyncSync(fd));
  }

  fchmod(fd: number, mode: Mode, callback: NoParamCallback): void {
    this.#deliver(takeCallback([callback]), () => this.fchmodSync(fd, mode));
  }

  fchown(fd: number, uid: number, gid: number, callback: NoParamCallback): void {
    this.#deliver(takeCallback([callback]), () => this.fchownSync(fd, uid, gid));
  }

  futimes(fd: number, atime: TimeLike, mtime: TimeLike, callback: NoParamCallback): void {
    this.#deliver(takeCallback([callback]), () => this.futimesSync(fd, atime, mtime));
  }

  truncate(path: PathLike, callback: NoParamCallback): void;
  truncate(path: PathLike, len: number | undefined | null, callback: NoParamCallback): void;
  truncate(path: PathLike, ...rest: unknown[]): void {
    const cb = takeCallback(rest);
    this.#deliver(cb, () => this.truncateSync(path, rest[0] as number));
  }

  copyFile(src: PathLike, dest: PathLike, callback: NoParamCallback): void;
  copyFile(src: PathLike, dest: PathLike, mode: number, callback: NoParamCallback): void;
  copyFile(src: PathLike, dest: PathLike, ...rest: unknown[]): void {
    const cb = takeCallback(rest);
    this.#deliver(cb, () => this.copyFileSync(src, dest, (rest[0] as number) ?? 0));
  }

  cp(src: PathLike, dest: PathLike, callback: NoParamCallback): void;
  cp(src: PathLike, dest: PathLike, options: CopyOptions, callback: NoParamCallback): void;
  cp(src: PathLike, dest: PathLike, ...rest: unknown[]): void {
    const cb = takeCallback(rest);
    this.#deliver(cb, () => this.cpSync(src, dest, rest[0] as CopyOptions));
  }

  mkdir(path: PathLike, callback: NoParamCallback): void;
  mkdir(path: PathLike, options: Mode | MakeDirectoryOptions | null | undefined, callback: (err: NodeJS.ErrnoException | null, path?: string) => void): void;
  mkdir(path: PathLike, ...rest: unknown[]): void {
    const cb = takeCallback(rest);
    this.#deliver(cb, () => this.mkdirSync(path, rest[0] as MakeDirectoryOptions));
  }

  mkdtemp(prefix: string, callback: Callback<string>): void;
  mkdtemp(prefix: string, options: { encoding?: Encoding | null } | Encoding | null | undefined, callback: Callback<string | Buffer>): void;
  mkdtemp(prefix: string, ...rest: unknown[]): void {
    const cb = takeCallback(rest);
    this.#deliver(cb, () => this.mkdtempSync(prefix, rest[0] as Encoding));
  }

  readdir(path: PathLike, callback: Callback<string[]>): void;
  readdir(path: PathLike, options: { withFileTypes: true; encoding?: BufferEncoding | null; recursive?: boolean }, callback: Callback<Dirent<string>[]>): void;
  readdir(path: PathLike, options: ReaddirOptions | Encoding | null | undefined, callback: Callback<ReaddirResult>): void;
  readdir(path: PathLike, ...rest: unknown[]): void {
    const cb = takeCallback(rest);
    this.#deliver(cb, () => this.readdirSync(path, rest[0] as ReaddirOptions));
  }

  opendir(path: PathLike, callback: Callback<Dir>): void;
  opendir(path: PathLike, options: OpenDirOptions | undefined, callback: Callback<Dir>): void;
  opendir(path: PathLike, ...rest: unknown[]): void {
    const cb = takeCallback(rest);
    this.#deliver(cb, () => this.opendirSync(path, rest[0] as OpenDirOptions));
  }

  rmdir(path: PathLike, callback: NoParamCallback): void;
  rmdir(path: PathLike, options: RmDirOptions | undefined, callback: NoParamCallback): void;
  rmdir(path: PathLike, ...rest: unknown[]): void {
    const cb = takeCallback(rest);
    this.#deliver(cb, () => this.rmdirSync(path, rest[0] as RmDirOptions));
  }

  rm(path: PathLike, callback: NoParamCallback): void;
  rm(path: PathLike, options: RmOptions | undefined, callback: NoParamCallback): void;
  rm(path: PathLike, ...rest: unknown[]): void {
    const cb = takeCallback(rest);
    this.#deliver(cb, () => this.rmSync(path, rest[0] as RmOptions));
  }

  unlink(path: PathLike, callback: NoParamCallback): void {
    this.#deliver(takeCallback([callback]), () => this.unlinkSync(path));
  }

  rename(oldPath: PathLike, newPath: PathLike, callback: NoParamCallback): void {
    this.#deliver(takeCallback([callback]), () => this.renameSync(oldPath, newPath));
  }

  symlink(target: PathLike, path: PathLike, callback: NoParamCallback): void;
  symlink(target: PathLike, path: PathLike, type: "file" | "dir" | "junction" | null | undefined, callback: NoParamCallback): void;
  symlink(target: PathLike, path: PathLike, ...rest: unknown[]): void {
    const cb = takeCallback(rest);
    this.#deliver(cb, () => this.symlinkSync(target, path));
  }

  readlink(path: PathLike, callback: Callback<string>): void;
  readlink(path: PathLike, options: { encoding?: Encoding | null } | Encoding | null | undefined, callback: Callback<string | Buffer>): void;
  readlink(path: PathLike, ...rest: unknown[]): void {
    const cb = takeCallback(rest);
    this.#deliver(cb, () => this.readlinkSync(path, rest[0] as Encoding));
  }

  stat(path: PathLike, callback: Callback<Stats>): void;
  stat(path: PathLike, options: { bigint?: false } | undefined, callback: Callback<Stats>): void;
  stat(path: PathLike, options: { bigint: true }, callback: Callback<BigIntStats>): void;
  stat(path: PathLike, ...rest: unknown[]): void {
    const cb = takeCallback(rest);
    const opts = { ...(rest[0] as StatOptions), throwIfNoEntry: true };
    this.#deliver(cb, () => this.statSync(path, opts));
  }

  lstat(path: PathLike, callback: Callback<Stats>): void;
  lstat(path: PathLike, options: { bigint?: false } | undefined, callback: Callback<Stats>): void;
  lstat(path: PathLike, options: { bigint: true }, callback: Callback<BigIntStats>): void;
  lstat(path: PathLike, ...rest: unknown[]): void {
    const cb = takeCallback(rest);
    const opts = { ...(rest[0] as StatOptions), throwIfNoEntry: true };
    this.#deliver(cb, () => this.lstatSync(path, opts));
  }

  /** Deprecated in Node but still provided: `callback(exists)`. */
  exists(path: PathLike, callback: (exists: boolean) => void): void {
    const cb = takeCallback([callback]);
    const result = this.existsSync(path);
    process.nextTick(cb, result);
  }

  access(path: PathLike, callback: NoParamCallback): void;
  access(path: PathLike, mode: number | undefined, callback: NoParamCallback): void;
  access(path: PathLike, ...rest: unknown[]): void {
    const cb = takeCallback(rest);
    this.#deliver(cb, () => this.accessSync(path, (rest[0] as number) ?? F_OK));
  }

  chmod(path: PathLike, mode: Mode, callback: NoParamCallback): void {
    this.#deliver(takeCallback([callback]), () => this.chmodSync(path, mode));
  }

  lchmod(path: PathLike, mode: Mode, callback: NoParamCallback): void {
    this.#deliver(takeCallback([callback]), () => this.lchmodSync(path, mode));
  }

  chown(path: PathLike, uid: number, gid: number, callback: NoParamCallback): void {
    this.#deliver(takeCallback([callback]), () => this.chownSync(path, uid, gid));
  }

  lchown(path: PathLike, uid: number, gid: number, callback: NoParamCallback): void {
    this.#deliver(takeCallback([callback]), () => this.lchownSync(path, uid, gid));
  }

  utimes(path: PathLike, atime: TimeLike, mtime: TimeLike, callback: NoParamCallback): void {
    this.#deliver(takeCallback([callback]), () => this.utimesSync(path, atime, mtime));
  }

  lutimes(path: PathLike, atime: TimeLike, mtime: TimeLike, callback: NoParamCallback): void {
    this.#deliver(takeCallback([callback]), () => this.lutimesSync(path, atime, mtime));
  }

  // ==================================================== Memspace extensions

  /** Current working directory used to resolve relative paths (Memspace extension). */
  cwd(): string {
    return this.#engine.cwd;
  }

  /** Change the working directory for relative paths (Memspace extension; per instance). */
  chdir(path: PathLike): void {
    this.#engine.chdir(pathToString(path));
  }

  /**
   * Set (or clear, with `null`) the time-to-live of an entry, in milliseconds
   * from now. Applies to the entry itself (symlinks are not followed).
   * Memspace extension.
   */
  setTtl(path: PathLike, ttl: number | null): void {
    const input = pathToString(path);
    const node = this.#engine.lookup(input, "setTtl", false);
    if (node === this.#engine.root) throw errnoError("EBUSY", { syscall: "setTtl", path: input });
    this.#engine.setTtl(node, ttl === null ? null : validateTtl(ttl)!);
  }

  /** Milliseconds until the entry expires, or `null` if it has no TTL. Memspace extension. */
  getTtl(path: PathLike): number | null {
    const node = this.#engine.lookup(pathToString(path), "getTtl", false);
    return node.expiresAt === null ? null : Math.max(0, node.expiresAt - this.#engine.now());
  }

  /** Remove all expired entries now; returns the number of entries removed. Memspace extension. */
  purgeExpired(): number {
    return this.#engine.purgeExpired();
  }

  /** Memspace-managed memory and node statistics (not process memory). */
  getStats(): MemspaceStats {
    return {
      ...this.#engine.memory.stats(),
      name: this.name,
      openFileDescriptors: this.#fds.size,
      watcherCount: this.#watchers.size,
      disposed: this.#disposed,
    };
  }

  /** Export the whole tree (contents and metadata). Nothing is written anywhere. */
  snapshot(options?: { format?: "json" }): MemspaceSnapshot;
  snapshot(options: { format: "binary" }): Buffer;
  snapshot(options?: SnapshotOptions): MemspaceSnapshot | Buffer;
  snapshot(options: SnapshotOptions = {}): MemspaceSnapshot | Buffer {
    const now = this.#engine.now();
    const entries = collectEntries(this.#engine.root, now);
    return options.format === "binary" ? toBinarySnapshot(entries, now) : toJsonSnapshot(entries, now);
  }

  /**
   * Replace this instance's entire contents with a snapshot (object, JSON
   * string or binary Buffer). The snapshot is fully validated and checked
   * against this instance's limits before anything changes. Open descriptors
   * are invalidated; watchers stay registered.
   */
  restore(snapshot: MemspaceSnapshot | Uint8Array | string): void {
    const decoded = decodeSnapshot(snapshot);
    const limits = this.#engine.memory.limits;
    if (decoded.contentBytes > limits.maxMemory) {
      throw errnoError("ENOSPC", { syscall: "restore", detail: `snapshot holds ${decoded.contentBytes} bytes; maxMemory is ${limits.maxMemory}` });
    }
    if (decoded.entries.length > limits.maxNodes) {
      throw errnoError("ENOSPC", { syscall: "restore", detail: `snapshot holds ${decoded.entries.length} nodes; maxNodes is ${limits.maxNodes}` });
    }
    this.#fds.clear();
    this.#engine.importEntries(decoded.entries);
  }

  /** Remove everything (the root stays). Open descriptors are invalidated. Memspace extension. */
  reset(): void {
    this.#fds.clear();
    this.#engine.reset();
    this.#ttl.clear();
  }

  /**
   * Release all data, descriptors, watchers and timers. Any later call throws
   * `ERR_MEMSPACE_DISPOSED`. Idempotent.
   */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#watchers.closeAll();
    this.#ttl.dispose();
    this.#fds.clear();
    this.#engine.destroy();
    this.#promises = undefined;
  }

  get isDisposed(): boolean {
    return this.#disposed;
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}

function zeroStats(bigint: boolean): AnyStats {
  const node: FsNode = {
    ino: 0, type: "file", name: "", parent: null, mode: 0, uid: 0, gid: 0,
    atimeMs: 0, mtimeMs: 0, ctimeMs: 0, birthtimeMs: 0, expiresAt: null, openCount: 0, detached: true,
    content: Buffer.alloc(0), size: 0,
  };
  const stats = bigint ? new BigIntStats(node) : new Stats(node);
  stats.mode = (bigint ? 0n : 0) as never;
  stats.dev = (bigint ? 0n : 0) as never;
  return stats;
}
