/**
 * Event-driven watchers.
 *
 * Native `fs.watch` relies on OS notification APIs; Memspace instead observes
 * its own engine, so every change made through the instance is reported
 * exactly (no polling, no missed or platform-specific coalesced events).
 * Events are delivered on a later tick so listeners may safely touch the
 * filesystem. Watchers hold no handles and never keep the process alive;
 * `persistent`, `ref()` and `unref()` are accepted for compatibility only.
 */
import { EventEmitter } from "node:events";
import type { Encoding } from "../core/encoding.js";
import { encodeName } from "../core/encoding.js";
import { basename, dirname, isSubpath, relativePath } from "../core/path.js";
import type { ChangeEvent, ChangeType, FsEngine } from "../engine/engine.js";
import { abortError } from "../errors/index.js";
import type { BigIntStats, Stats } from "../metadata/stats.js";

export type WatchListener = (eventType: ChangeType, filename: string | Buffer | null) => void;
export type StatsListener = (current: Stats | BigIntStats, previous: Stats | BigIntStats) => void;

interface Subscription {
  path: string;
  isDirectory: boolean;
  recursive: boolean;
  deliver(type: ChangeType, filename: string): void;
}

/** Owns every watcher of one instance and fans engine events out to them. */
export class WatchRegistry {
  private readonly subscriptions = new Set<Subscription>();
  private readonly fsWatchers = new Set<FSWatcher>();
  private readonly statWatchers = new Map<string, StatWatcher>();
  private unsubscribe: (() => void) | undefined;

  constructor(private readonly engine: FsEngine) {}

  get size(): number {
    return this.fsWatchers.size + this.statWatchers.size;
  }

  add(subscription: Subscription): void {
    this.subscriptions.add(subscription);
    this.unsubscribe ??= this.engine.subscribe((event) => this.dispatch(event));
  }

  remove(subscription: Subscription): void {
    this.subscriptions.delete(subscription);
    if (this.subscriptions.size === 0 && this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
  }

  private dispatch(event: ChangeEvent): void {
    for (const sub of this.subscriptions) {
      if (event.path === sub.path) {
        sub.deliver(event.type, basename(sub.path) || "/");
      } else if (sub.isDirectory && isSubpath(sub.path, event.path)) {
        if (sub.recursive || dirname(event.path) === sub.path) {
          sub.deliver(event.type, relativePath(sub.path, event.path));
        }
      } else if (isSubpath(event.path, sub.path)) {
        // An ancestor of the watched path was renamed or removed.
        if (event.type === "rename") sub.deliver("rename", basename(sub.path));
      }
    }
  }

  trackWatcher(watcher: FSWatcher): void {
    this.fsWatchers.add(watcher);
  }

  untrackWatcher(watcher: FSWatcher): void {
    this.fsWatchers.delete(watcher);
  }

  statWatcher(path: string, create: () => StatWatcher): StatWatcher {
    let watcher = this.statWatchers.get(path);
    if (!watcher) {
      watcher = create();
      this.statWatchers.set(path, watcher);
    }
    return watcher;
  }

  getStatWatcher(path: string): StatWatcher | undefined {
    return this.statWatchers.get(path);
  }

  dropStatWatcher(path: string): void {
    this.statWatchers.get(path)?.stop();
    this.statWatchers.delete(path);
  }

  closeAll(): void {
    for (const watcher of [...this.fsWatchers]) watcher.close();
    for (const path of [...this.statWatchers.keys()]) this.dropStatWatcher(path);
    this.subscriptions.clear();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }
}

/** Returned by `fs.watch()`. Emits `'change'`, `'error'` and `'close'`. */
export class FSWatcher extends EventEmitter {
  private closed = false;
  private readonly subscription: Subscription;

  /** @internal */
  constructor(
    private readonly registry: WatchRegistry,
    path: string,
    isDirectory: boolean,
    recursive: boolean,
    encoding: Encoding | null | undefined,
    signal: AbortSignal | undefined,
  ) {
    super();
    this.subscription = {
      path,
      isDirectory,
      recursive,
      deliver: (type, filename) => {
        process.nextTick(() => {
          if (!this.closed) this.emit("change", type, encodeName(filename, encoding));
        });
      },
    };
    registry.add(this.subscription);
    registry.trackWatcher(this);
    if (signal) {
      if (signal.aborted) process.nextTick(() => this.close());
      else signal.addEventListener("abort", () => this.close(), { once: true });
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.registry.remove(this.subscription);
    this.registry.untrackWatcher(this);
    process.nextTick(() => this.emit("close"));
  }

  /** No-op: Memspace watchers never hold the event loop open. */
  ref(): this {
    return this;
  }

  /** No-op: Memspace watchers never hold the event loop open. */
  unref(): this {
    return this;
  }
}

/** Backs `fs.watchFile()`: compares stats after each relevant change (event-driven, no polling). */
export class StatWatcher extends EventEmitter {
  private previous: Stats | BigIntStats;
  private readonly subscription: Subscription;
  private scheduled = false;

  /** @internal */
  constructor(
    private readonly registry: WatchRegistry,
    path: string,
    private readonly statNow: () => Stats | BigIntStats,
  ) {
    super();
    this.previous = statNow();
    this.subscription = {
      path,
      isDirectory: false,
      recursive: false,
      deliver: () => {
        if (this.scheduled) return;
        this.scheduled = true;
        process.nextTick(() => {
          this.scheduled = false;
          const current = this.statNow();
          const prev = this.previous;
          if (
            current.mtimeMs !== prev.mtimeMs ||
            current.ctimeMs !== prev.ctimeMs ||
            current.size !== prev.size ||
            current.ino !== prev.ino ||
            current.mode !== prev.mode
          ) {
            this.previous = current;
            this.emit("change", current, prev);
          }
        });
      },
    };
    registry.add(this.subscription);
  }

  /** @internal */
  stop(): void {
    this.registry.remove(this.subscription);
    this.removeAllListeners("change");
    this.emit("stop");
  }

  ref(): this {
    return this;
  }

  unref(): this {
    return this;
  }
}

/** Async iterator used by `fs.promises.watch()`. */
export function watchIterator(
  start: (listener: WatchListener) => FSWatcher,
  signal: AbortSignal | undefined,
): AsyncIterableIterator<{ eventType: ChangeType; filename: string | Buffer | null }> {
  type Event = { eventType: ChangeType; filename: string | Buffer | null };
  const queue: Event[] = [];
  let waiting: { resolve: (r: IteratorResult<Event>) => void; reject: (e: unknown) => void } | undefined;
  let done = false;
  let failure: unknown;

  const watcher = start((eventType, filename) => {
    const event = { eventType, filename };
    if (waiting) {
      const w = waiting;
      waiting = undefined;
      w.resolve({ value: event, done: false });
    } else {
      queue.push(event);
    }
  });

  const finish = (error?: unknown) => {
    if (done) return;
    done = true;
    failure = error;
    if (error) queue.length = 0;
    watcher.close();
    if (waiting) {
      const w = waiting;
      waiting = undefined;
      if (error) w.reject(error);
      else w.resolve({ value: undefined, done: true });
    }
  };

  if (signal) {
    if (signal.aborted) finish(abortError(signal));
    else signal.addEventListener("abort", () => finish(abortError(signal)), { once: true });
  }

  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    next() {
      const event = queue.shift();
      if (event) return Promise.resolve({ value: event, done: false });
      if (done) return failure ? Promise.reject(failure) : Promise.resolve({ value: undefined, done: true });
      return new Promise((resolve, reject) => {
        waiting = { resolve, reject };
      });
    },
    return() {
      finish();
      return Promise.resolve({ value: undefined, done: true });
    },
  };
}
