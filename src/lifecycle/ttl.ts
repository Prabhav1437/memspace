import type { FsEngine } from "../engine/engine.js";

const MAX_TIMER_DELAY = 2 ** 31 - 1;

/**
 * Schedules reclamation of expired TTL entries.
 *
 * Correctness never depends on the timer: the engine treats expired entries as
 * absent on every access. The timer only frees memory promptly. It is a single
 * `unref()`'d timeout aimed at the earliest expiry, so it never keeps the
 * process alive and costs nothing when no TTLs are pending.
 */
export class TtlManager {
  private timer: NodeJS.Timeout | undefined;
  private scheduledFor: number | null = null;

  constructor(
    private readonly engine: FsEngine,
    private readonly strategy: "timer" | "lazy",
  ) {
    engine.onTtlChange = () => this.schedule();
  }

  schedule(): void {
    if (this.strategy !== "timer") return;
    const next = this.engine.nextExpiry();
    if (next === null) {
      this.clear();
      return;
    }
    if (this.timer && this.scheduledFor !== null && this.scheduledFor <= next) return;
    this.clear();
    const delay = Math.min(MAX_TIMER_DELAY, Math.max(0, next - this.engine.now()));
    this.scheduledFor = next;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.scheduledFor = null;
      this.engine.purgeExpired();
      this.schedule();
    }, delay);
    this.timer.unref();
  }

  get pending(): boolean {
    return this.timer !== undefined;
  }

  clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.scheduledFor = null;
  }

  dispose(): void {
    this.clear();
    this.engine.onTtlChange = undefined;
  }
}
