/**
 * Readable and writable streams over Memspace files.
 *
 * They follow `fs.ReadStream` / `fs.WriteStream` semantics: lazy open in
 * `_construct` (emitting `'open'` and `'ready'`), inclusive `start`/`end`
 * ranges, `bytesRead` / `bytesWritten`, `autoClose`, `emitClose`, and errors
 * surfaced through the standard `'error'` event. Backpressure and destruction
 * come from Node's own `stream.Readable` / `stream.Writable` machinery. No
 * temporary physical files are ever created.
 */
import { Readable, Writable } from "node:stream";
import { invalidArgType, outOfRange } from "../errors/index.js";
import type { ReadStreamOptions, WriteStreamOptions } from "../api/types.js";
import type { OpenMode } from "../core/flags.js";

/** The subset of a Memspace instance the streams need (keeps streams decoupled from the API class). */
export interface StreamHost {
  openSync(path: string, flags: OpenMode, mode?: number): number;
  closeSync(fd: number): void;
  readSync(fd: number, buffer: Uint8Array, offset: number, length: number, position: number | null): number;
  writeSync(fd: number, buffer: Uint8Array, offset: number, length: number, position: number | null): number;
  /** @internal Apply a TTL to the file behind a descriptor. */
  applyTtlToDescriptor(fd: number, ttl: number): void;
}

function validatePosition(name: string, value: unknown, min = 0): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number") throw invalidArgType(name, "of type number", value);
  if (!Number.isInteger(value) || value < min || value > Number.MAX_SAFE_INTEGER) {
    throw outOfRange(name, `>= ${min} && <= ${Number.MAX_SAFE_INTEGER}`, value);
  }
  return value;
}

function readRange(options: ReadStreamOptions): { start: number | undefined; end: number } {
  const start = validatePosition("start", options.start);
  const end = validatePosition("end", options.end) ?? Infinity;
  if (start !== undefined && start > end) throw outOfRange("start", `<= "end" (here: ${end})`, start);
  return { start, end };
}

export class ReadStream extends Readable {
  /** Path the stream reads from (undefined when constructed from a descriptor). */
  readonly path: string | undefined;
  fd: number | null;
  flags: OpenMode;
  mode: number;
  start: number | undefined;
  end: number;
  pos: number | undefined;
  bytesRead = 0;
  autoClose: boolean;

  private readonly host: StreamHost;

  /** @internal Use `fs.createReadStream()`. */
  constructor(host: StreamHost, path: string | undefined, options: ReadStreamOptions) {
    // Validate before super(): Readable schedules _construct (which opens the file) in its constructor.
    const range = readRange(options);
    super({
      highWaterMark: options.highWaterMark ?? 64 * 1024,
      ...(options.encoding ? { encoding: options.encoding } : {}),
      emitClose: options.emitClose ?? true,
      autoDestroy: true,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    this.host = host;
    this.path = path;
    this.fd = options.fd ?? null;
    this.flags = options.flags ?? "r";
    this.mode = options.mode ?? 0o666;
    this.autoClose = options.autoClose ?? true;
    this.start = range.start;
    this.end = range.end;
    this.pos = this.start;
  }

  /** True until the underlying file has been opened. */
  get pending(): boolean {
    return this.fd === null;
  }

  override _construct(callback: (error?: Error | null) => void): void {
    if (this.fd !== null) {
      callback();
      return;
    }
    try {
      this.fd = this.host.openSync(this.path!, this.flags, this.mode);
    } catch (error) {
      callback(error as Error);
      return;
    }
    this.emit("open", this.fd);
    this.emit("ready");
    callback();
  }

  override _read(size: number): void {
    const remaining = this.end === Infinity ? size : Math.min(size, this.end - (this.pos ?? 0) + 1);
    if (remaining <= 0) {
      this.push(null);
      return;
    }
    const buffer = Buffer.allocUnsafe(remaining);
    let count: number;
    try {
      count = this.host.readSync(this.fd!, buffer, 0, remaining, this.pos ?? null);
    } catch (error) {
      this.destroy(error as Error);
      return;
    }
    if (this.pos !== undefined) this.pos += count;
    this.bytesRead += count;
    if (count === 0) this.push(null);
    else this.push(count === remaining ? buffer : buffer.subarray(0, count));
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    if (this.fd !== null && this.autoClose) {
      try {
        this.host.closeSync(this.fd);
      } catch (closeError) {
        error ??= closeError as Error;
      }
      this.fd = null;
    }
    callback(error);
  }

  /** Close the stream (alias of `destroy()` that accepts a callback for `'close'`). */
  close(callback?: (error?: Error | null) => void): void {
    if (callback) this.once("close", () => callback());
    this.destroy();
  }
}

export class WriteStream extends Writable {
  readonly path: string | undefined;
  fd: number | null;
  flags: OpenMode;
  mode: number;
  start: number | undefined;
  pos: number | undefined;
  bytesWritten = 0;
  autoClose: boolean;
  private readonly ttl: number | undefined;
  private readonly host: StreamHost;

  /** @internal Use `fs.createWriteStream()`. */
  constructor(host: StreamHost, path: string | undefined, options: WriteStreamOptions) {
    const start = validatePosition("start", options.start);
    super({
      highWaterMark: options.highWaterMark ?? 16 * 1024,
      decodeStrings: true,
      defaultEncoding: options.encoding ?? "utf8",
      emitClose: options.emitClose ?? true,
      autoDestroy: true,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    this.host = host;
    this.path = path;
    this.fd = options.fd ?? null;
    this.flags = options.flags ?? "w";
    this.mode = options.mode ?? 0o666;
    this.autoClose = options.autoClose ?? true;
    this.start = start;
    this.pos = this.start;
    this.ttl = options.ttl;
  }

  get pending(): boolean {
    return this.fd === null;
  }

  override _construct(callback: (error?: Error | null) => void): void {
    if (this.fd === null) {
      try {
        this.fd = this.host.openSync(this.path!, this.flags, this.mode);
      } catch (error) {
        callback(error as Error);
        return;
      }
    }
    try {
      if (this.ttl !== undefined) this.host.applyTtlToDescriptor(this.fd, this.ttl);
    } catch (error) {
      callback(error as Error);
      return;
    }
    this.emit("open", this.fd);
    this.emit("ready");
    callback();
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    try {
      const written = this.host.writeSync(this.fd!, chunk, 0, chunk.byteLength, this.pos ?? null);
      this.bytesWritten += written;
      if (this.pos !== undefined) this.pos += written;
    } catch (error) {
      callback(error as Error);
      return;
    }
    callback();
  }

  override _writev(
    chunks: Array<{ chunk: Buffer; encoding: BufferEncoding }>,
    callback: (error?: Error | null) => void,
  ): void {
    this._write(Buffer.concat(chunks.map((c) => c.chunk)), "binary", callback);
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    if (this.fd !== null && this.autoClose) {
      try {
        this.host.closeSync(this.fd);
      } catch (closeError) {
        error ??= closeError as Error;
      }
      this.fd = null;
    }
    callback(error);
  }

  close(callback?: (error?: Error | null) => void): void {
    if (callback) {
      if (this.closed) {
        process.nextTick(callback);
        return;
      }
      this.once("close", () => callback());
    }
    if (!this.writableEnded) this.end();
    else if (!this.destroyed) this.destroy();
  }

  /** Alias of `destroy()` kept for `fs.WriteStream` compatibility. */
  destroySoon(): void {
    this.end();
  }
}
