import { codedError } from "../errors/index.js";
import type { Dirent } from "../metadata/stats.js";

/**
 * Directory handle returned by `opendir()`.
 *
 * Unlike the native implementation, which reads entries from the OS in
 * batches, a Memspace `Dir` captures the directory listing when it is opened.
 * Entries added or removed afterwards are not reflected (POSIX leaves this
 * unspecified for readdir as well).
 */
export class Dir {
  readonly path: string;
  private readonly pending: Dirent<string | Buffer>[];
  private closed = false;

  /** @internal */
  constructor(path: string, entries: Dirent<string | Buffer>[]) {
    this.path = path;
    this.pending = entries;
  }

  private assertOpen(): void {
    if (this.closed) throw codedError("ERR_DIR_CLOSED", "Directory handle was closed");
  }

  readSync(): Dirent<string | Buffer> | null {
    this.assertOpen();
    return this.pending.shift() ?? null;
  }

  read(): Promise<Dirent<string | Buffer> | null>;
  read(callback: (err: Error | null, entry: Dirent<string | Buffer> | null) => void): void;
  read(callback?: (err: Error | null, entry: Dirent<string | Buffer> | null) => void): Promise<Dirent<string | Buffer> | null> | void {
    if (callback) {
      let entry: Dirent<string | Buffer> | null;
      try {
        entry = this.readSync();
      } catch (error) {
        process.nextTick(callback, error as Error, null);
        return;
      }
      process.nextTick(callback, null, entry);
      return;
    }
    try {
      return Promise.resolve(this.readSync());
    } catch (error) {
      return Promise.reject(error);
    }
  }

  closeSync(): void {
    this.assertOpen();
    this.closed = true;
    this.pending.length = 0;
  }

  close(): Promise<void>;
  close(callback: (err: Error | null) => void): void;
  close(callback?: (err: Error | null) => void): Promise<void> | void {
    try {
      this.closeSync();
    } catch (error) {
      if (callback) return void process.nextTick(callback, error as Error);
      return Promise.reject(error);
    }
    if (callback) return void process.nextTick(callback, null);
    return Promise.resolve();
  }

  async *entries(): AsyncGenerator<Dirent<string | Buffer>> {
    try {
      for (let entry = this.readSync(); entry !== null; entry = this.readSync()) yield entry;
    } finally {
      if (!this.closed) this.closeSync();
    }
  }

  [Symbol.asyncIterator](): AsyncGenerator<Dirent<string | Buffer>> {
    return this.entries();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    if (!this.closed) this.closeSync();
  }

  [Symbol.dispose](): void {
    if (!this.closed) this.closeSync();
  }
}
