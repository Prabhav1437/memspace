/**
 * `fs.promises`-compatible API.
 *
 * Each method performs the same synchronous engine operation as its `*Sync`
 * counterpart and settles a promise with the outcome, so the promise API has
 * identical semantics (and every validation error becomes a rejection, as in
 * Node's `fs/promises`).
 */
import { normalizeOptions, toBuffer, type Encoding, type WriteData } from "../core/encoding.js";
import type { OpenMode } from "../core/flags.js";
import type { PathLike } from "../core/path.js";
import { abortError, errnoError } from "../errors/index.js";
import type { BigIntStats, Dirent, Stats } from "../metadata/stats.js";
import type { ReadStream, WriteStream } from "../streams/streams.js";
import type { Dir } from "./dir.js";
import type {
  CopyOptions,
  MakeDirectoryOptions,
  Mode,
  OpenDirOptions,
  ReadFileOptions,
  ReaddirOptions,
  ReadStreamOptions,
  RmDirOptions,
  RmOptions,
  StatOptions,
  TimeLike,
  WatchOptions,
  WriteFileOptions,
  WriteStreamOptions,
} from "./types.js";
import type { VirtualFileSystem } from "./vfs.js";
import { watchIterator } from "./watch.js";

type AnyStats = Stats | BigIntStats;
type Data = WriteData | Iterable<WriteData> | AsyncIterable<WriteData>;

function checkAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError(signal);
}

function isIterableData(data: unknown): data is Iterable<WriteData> | AsyncIterable<WriteData> {
  if (typeof data === "string" || ArrayBuffer.isView(data)) return false;
  return typeof data === "object" && data !== null && (Symbol.asyncIterator in data || Symbol.iterator in data);
}

async function collect(data: Data, encoding: Encoding | null | undefined, signal?: AbortSignal): Promise<Buffer> {
  if (!isIterableData(data)) return toBuffer(data, encoding ?? "utf8");
  const chunks: Buffer[] = [];
  for await (const chunk of data as AsyncIterable<WriteData>) {
    checkAborted(signal);
    chunks.push(Buffer.from(toBuffer(chunk, encoding ?? "utf8")));
  }
  return Buffer.concat(chunks);
}

/** Promise-based handle returned by `fs.promises.open()`. */
export class FileHandle {
  #fd: number;
  #closed = false;
  #closing: Promise<void> | undefined;

  /** @internal */
  constructor(
    private readonly vfs: VirtualFileSystem,
    fd: number,
  ) {
    this.#fd = fd;
  }

  /** The numeric descriptor, or -1 once closed. */
  get fd(): number {
    return this.#closed ? -1 : this.#fd;
  }

  #live(syscall: string): number {
    if (this.#closed) throw errnoError("EBADF", { syscall });
    return this.#fd;
  }

  async read(buffer?: NodeJS.ArrayBufferView | { buffer?: NodeJS.ArrayBufferView; offset?: number; length?: number; position?: number | bigint | null }, offset?: number | null, length?: number | null, position?: number | bigint | null): Promise<{ bytesRead: number; buffer: NodeJS.ArrayBufferView }> {
    const fd = this.#live("read");
    let target: NodeJS.ArrayBufferView;
    if (buffer === undefined || !ArrayBuffer.isView(buffer)) {
      const opts = buffer ?? {};
      target = opts.buffer ?? Buffer.alloc(16384);
      offset = opts.offset ?? 0;
      length = opts.length ?? target.byteLength - offset;
      position = opts.position ?? null;
    } else {
      target = buffer;
    }
    const bytesRead = this.vfs.readSync(fd, target, offset ?? 0, length ?? target.byteLength - (offset ?? 0), position ?? null);
    return { bytesRead, buffer: target };
  }

  async write(data: NodeJS.ArrayBufferView | string, offsetOrPosition?: number | null, lengthOrEncoding?: number | BufferEncoding | null, position?: number | null): Promise<{ bytesWritten: number; buffer: NodeJS.ArrayBufferView | string }> {
    const fd = this.#live("write");
    const bytesWritten = typeof data === "string"
      ? this.vfs.writeSync(fd, data, offsetOrPosition ?? null, (lengthOrEncoding as BufferEncoding | null) ?? "utf8")
      : this.vfs.writeSync(fd, data, offsetOrPosition ?? 0, (lengthOrEncoding as number | null) ?? undefined, position ?? null);
    return { bytesWritten, buffer: data };
  }

  async readFile(options?: ReadFileOptions | Encoding | null): Promise<string | Buffer> {
    const opts = normalizeOptions<ReadFileOptions>(options, {});
    checkAborted(opts.signal);
    return this.vfs.readFileSync(this.#live("read"), { encoding: opts.encoding ?? null });
  }

  async writeFile(data: Data, options?: WriteFileOptions | Encoding | null): Promise<void> {
    const opts = normalizeOptions<WriteFileOptions>(options, {});
    const bytes = await collect(data, opts.encoding, opts.signal);
    checkAborted(opts.signal);
    this.vfs.writeFileSync(this.#live("write"), bytes, { ...(opts.ttl === undefined ? {} : { ttl: opts.ttl }) });
  }

  async appendFile(data: Data, options?: WriteFileOptions | Encoding | null): Promise<void> {
    return this.writeFile(data, options);
  }

  async stat(options?: { bigint?: boolean }): Promise<AnyStats> {
    return this.vfs.fstatSync(this.#live("fstat"), options as { bigint?: false });
  }

  async truncate(len?: number): Promise<void> {
    this.vfs.ftruncateSync(this.#live("ftruncate"), len);
  }

  async sync(): Promise<void> {
    this.vfs.fsyncSync(this.#live("fsync"));
  }

  async datasync(): Promise<void> {
    this.vfs.fdatasyncSync(this.#live("fdatasync"));
  }

  async chmod(mode: Mode): Promise<void> {
    this.vfs.fchmodSync(this.#live("fchmod"), mode);
  }

  async chown(uid: number, gid: number): Promise<void> {
    this.vfs.fchownSync(this.#live("fchown"), uid, gid);
  }

  async utimes(atime: TimeLike, mtime: TimeLike): Promise<void> {
    this.vfs.futimesSync(this.#live("futime"), atime, mtime);
  }

  createReadStream(options?: Omit<ReadStreamOptions, "fd">): ReadStream {
    return this.vfs.createReadStream(null, { ...options, fd: this.#live("read") });
  }

  createWriteStream(options?: Omit<WriteStreamOptions, "fd">): WriteStream {
    return this.vfs.createWriteStream(null, { ...options, fd: this.#live("write") });
  }

  async *readLines(options?: { encoding?: BufferEncoding }): AsyncGenerator<string> {
    const text = (await this.readFile({ encoding: options?.encoding ?? "utf8" })) as string;
    const lines = text.split(/\r?\n/);
    if (lines[lines.length - 1] === "") lines.pop();
    yield* lines;
  }

  close(): Promise<void> {
    if (this.#closed) return this.#closing ?? Promise.resolve();
    this.#closed = true;
    this.#closing = (async () => {
      try {
        this.vfs.closeSync(this.#fd);
      } catch (error) {
        // Already invalidated by reset()/restore()/dispose(): closing is still a success.
        if ((error as { code?: string }).code !== "EBADF" && (error as { code?: string }).code !== "ERR_MEMSPACE_DISPOSED") throw error;
      }
    })();
    return this.#closing;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

/** Create the `fs.promises` object for an instance. */
export function createPromisesApi(vfs: VirtualFileSystem): PromisesApi {
  const api = {
    constants: vfs.constants,
    FileHandle,

    async open(path: PathLike, flags: OpenMode = "r", mode?: Mode): Promise<FileHandle> {
      return new FileHandle(vfs, vfs.openSync(path, flags, mode));
    },

    async readFile(path: PathLike | FileHandle, options?: ReadFileOptions | Encoding | null): Promise<string | Buffer> {
      const opts = normalizeOptions<ReadFileOptions>(options, {});
      checkAborted(opts.signal);
      if (path instanceof FileHandle) return path.readFile(opts);
      return vfs.readFileSync(path, { encoding: opts.encoding ?? null, flag: opts.flag ?? "r" });
    },

    async writeFile(file: PathLike | FileHandle, data: Data, options?: WriteFileOptions | Encoding | null): Promise<void> {
      const opts = normalizeOptions<WriteFileOptions>(options, {});
      checkAborted(opts.signal);
      if (file instanceof FileHandle) return file.writeFile(data, opts);
      const bytes = await collect(data, opts.encoding, opts.signal);
      checkAborted(opts.signal);
      const { signal: _signal, ...rest } = opts;
      vfs.writeFileSync(file, bytes, { ...rest, encoding: null });
    },

    async appendFile(file: PathLike | FileHandle, data: Data, options?: WriteFileOptions | Encoding | null): Promise<void> {
      const opts = normalizeOptions<WriteFileOptions>(options, {});
      if (file instanceof FileHandle) return file.appendFile(data, opts);
      const bytes = await collect(data, opts.encoding, opts.signal);
      const { signal: _signal, ...rest } = opts;
      vfs.appendFileSync(file, bytes, { ...rest, encoding: null });
    },

    async access(path: PathLike, mode?: number): Promise<void> {
      vfs.accessSync(path, mode);
    },
    async copyFile(src: PathLike, dest: PathLike, mode?: number): Promise<void> {
      vfs.copyFileSync(src, dest, mode);
    },
    async cp(src: PathLike, dest: PathLike, options?: CopyOptions): Promise<void> {
      vfs.cpSync(src, dest, options);
    },
    async rename(oldPath: PathLike, newPath: PathLike): Promise<void> {
      vfs.renameSync(oldPath, newPath);
    },
    async unlink(path: PathLike): Promise<void> {
      vfs.unlinkSync(path);
    },
    async truncate(path: PathLike, len?: number): Promise<void> {
      vfs.truncateSync(path, len);
    },
    async mkdir(path: PathLike, options?: Mode | MakeDirectoryOptions | null): Promise<string | undefined> {
      return vfs.mkdirSync(path, options);
    },
    async mkdtemp(prefix: string, options?: { encoding?: Encoding | null } | Encoding | null): Promise<string> {
      return vfs.mkdtempSync(prefix, options);
    },
    async readdir(path: PathLike, options?: ReaddirOptions | Encoding | null): Promise<string[] | Buffer[] | Dirent<string>[] | Dirent<Buffer>[]> {
      return vfs.readdirSync(path, options);
    },
    async opendir(path: PathLike, options?: OpenDirOptions): Promise<Dir> {
      return vfs.opendirSync(path, options);
    },
    async rmdir(path: PathLike, options?: RmDirOptions): Promise<void> {
      vfs.rmdirSync(path, options);
    },
    async rm(path: PathLike, options?: RmOptions): Promise<void> {
      vfs.rmSync(path, options);
    },
    async stat(path: PathLike, options?: StatOptions): Promise<AnyStats> {
      return vfs.statSync(path, { ...options, throwIfNoEntry: true }) as AnyStats;
    },
    async lstat(path: PathLike, options?: StatOptions): Promise<AnyStats> {
      return vfs.lstatSync(path, { ...options, throwIfNoEntry: true }) as AnyStats;
    },
    async realpath(path: PathLike, options?: { encoding?: Encoding | null } | Encoding | null): Promise<string | Buffer> {
      return vfs.realpathSync.native(path, options);
    },
    async symlink(target: PathLike, path: PathLike, type?: "file" | "dir" | "junction" | null): Promise<void> {
      vfs.symlinkSync(target, path, type);
    },
    async readlink(path: PathLike, options?: { encoding?: Encoding | null } | Encoding | null): Promise<string | Buffer> {
      return vfs.readlinkSync(path, options);
    },
    async chmod(path: PathLike, mode: Mode): Promise<void> {
      vfs.chmodSync(path, mode);
    },
    async lchmod(path: PathLike, mode: Mode): Promise<void> {
      vfs.lchmodSync(path, mode);
    },
    async chown(path: PathLike, uid: number, gid: number): Promise<void> {
      vfs.chownSync(path, uid, gid);
    },
    async lchown(path: PathLike, uid: number, gid: number): Promise<void> {
      vfs.lchownSync(path, uid, gid);
    },
    async utimes(path: PathLike, atime: TimeLike, mtime: TimeLike): Promise<void> {
      vfs.utimesSync(path, atime, mtime);
    },
    async lutimes(path: PathLike, atime: TimeLike, mtime: TimeLike): Promise<void> {
      vfs.lutimesSync(path, atime, mtime);
    },

    /** Async iterator of change events (event-driven; see `fs.watch`). */
    watch(filename: PathLike, options?: WatchOptions | Encoding): AsyncIterableIterator<{ eventType: "rename" | "change"; filename: string | Buffer | null }> {
      const opts = normalizeOptions<WatchOptions>(options, {});
      const { signal, ...watchOpts } = opts;
      return watchIterator((listener) => vfs.watch(filename, watchOpts, listener), signal);
    },
  };
  return api as PromisesApi;
}

type Untyped = Omit<ReturnType<typeof untypedShape>, "readFile" | "readdir" | "stat" | "lstat" | "mkdir" | "realpath" | "readlink" | "mkdtemp">;
declare function untypedShape(): {
  constants: VirtualFileSystem["constants"];
  FileHandle: typeof FileHandle;
  open(path: PathLike, flags?: OpenMode, mode?: Mode): Promise<FileHandle>;
  writeFile(file: PathLike | FileHandle, data: Data, options?: WriteFileOptions | Encoding | null): Promise<void>;
  appendFile(file: PathLike | FileHandle, data: Data, options?: WriteFileOptions | Encoding | null): Promise<void>;
  access(path: PathLike, mode?: number): Promise<void>;
  copyFile(src: PathLike, dest: PathLike, mode?: number): Promise<void>;
  cp(src: PathLike, dest: PathLike, options?: CopyOptions): Promise<void>;
  rename(oldPath: PathLike, newPath: PathLike): Promise<void>;
  unlink(path: PathLike): Promise<void>;
  truncate(path: PathLike, len?: number): Promise<void>;
  opendir(path: PathLike, options?: OpenDirOptions): Promise<Dir>;
  rmdir(path: PathLike, options?: RmDirOptions): Promise<void>;
  rm(path: PathLike, options?: RmOptions): Promise<void>;
  symlink(target: PathLike, path: PathLike, type?: "file" | "dir" | "junction" | null): Promise<void>;
  chmod(path: PathLike, mode: Mode): Promise<void>;
  lchmod(path: PathLike, mode: Mode): Promise<void>;
  chown(path: PathLike, uid: number, gid: number): Promise<void>;
  lchown(path: PathLike, uid: number, gid: number): Promise<void>;
  utimes(path: PathLike, atime: TimeLike, mtime: TimeLike): Promise<void>;
  lutimes(path: PathLike, atime: TimeLike, mtime: TimeLike): Promise<void>;
  watch(filename: PathLike, options?: WatchOptions | Encoding): AsyncIterableIterator<{ eventType: "rename" | "change"; filename: string | Buffer | null }>;
};

/** Shape of `fs.promises` on a Memspace instance. */
export interface PromisesApi extends Untyped {
  readFile(path: PathLike | FileHandle, options?: { encoding?: null; flag?: OpenMode; signal?: AbortSignal } | null): Promise<Buffer>;
  readFile(path: PathLike | FileHandle, options: { encoding: BufferEncoding; flag?: OpenMode; signal?: AbortSignal } | BufferEncoding): Promise<string>;
  readFile(path: PathLike | FileHandle, options?: ReadFileOptions | Encoding | null): Promise<string | Buffer>;

  readdir(path: PathLike, options?: { encoding?: BufferEncoding | null; withFileTypes?: false; recursive?: boolean } | BufferEncoding | null): Promise<string[]>;
  readdir(path: PathLike, options: { encoding: "buffer"; withFileTypes?: false; recursive?: boolean } | "buffer"): Promise<Buffer[]>;
  readdir(path: PathLike, options: { encoding?: BufferEncoding | null; withFileTypes: true; recursive?: boolean }): Promise<Dirent<string>[]>;
  readdir(path: PathLike, options?: ReaddirOptions | Encoding | null): Promise<string[] | Buffer[] | Dirent<string>[] | Dirent<Buffer>[]>;

  stat(path: PathLike, options?: { bigint?: false }): Promise<Stats>;
  stat(path: PathLike, options: { bigint: true }): Promise<BigIntStats>;
  stat(path: PathLike, options?: StatOptions): Promise<AnyStats>;
  lstat(path: PathLike, options?: { bigint?: false }): Promise<Stats>;
  lstat(path: PathLike, options: { bigint: true }): Promise<BigIntStats>;
  lstat(path: PathLike, options?: StatOptions): Promise<AnyStats>;

  mkdir(path: PathLike, options: MakeDirectoryOptions & { recursive: true }): Promise<string | undefined>;
  mkdir(path: PathLike, options?: Mode | (MakeDirectoryOptions & { recursive?: false }) | null): Promise<undefined>;
  mkdir(path: PathLike, options?: Mode | MakeDirectoryOptions | null): Promise<string | undefined>;

  realpath(path: PathLike, options?: { encoding?: BufferEncoding | null } | BufferEncoding | null): Promise<string>;
  realpath(path: PathLike, options: { encoding: "buffer" } | "buffer"): Promise<Buffer>;
  readlink(path: PathLike, options?: { encoding?: BufferEncoding | null } | BufferEncoding | null): Promise<string>;
  readlink(path: PathLike, options: { encoding: "buffer" } | "buffer"): Promise<Buffer>;
  mkdtemp(prefix: string, options?: { encoding?: BufferEncoding | null } | BufferEncoding | null): Promise<string>;
  mkdtemp(prefix: string, options: { encoding: "buffer" } | "buffer"): Promise<Buffer>;
}
