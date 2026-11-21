import { errnoError } from "../errors/index.js";
import type { FsNode } from "../core/nodes.js";
import { capacityBytes, contentBytes } from "../core/nodes.js";

export interface MemoryLimits {
  /** Maximum bytes of file content (and symlink targets). Default: unlimited. */
  maxMemory: number;
  /** Maximum number of nodes, including the root directory. Default: unlimited. */
  maxNodes: number;
}

/**
 * Memspace-managed memory statistics. These count only bytes Memspace stores
 * for file contents; they are not the Node.js process's total memory usage.
 */
export interface MemoryStats {
  /** Logical bytes of stored file content and symlink targets. Counted against `maxMemory`. */
  usedMemory: number;
  /** Bytes actually allocated for file content, including spare growth capacity. */
  allocatedMemory: number;
  /** Configured limit (`Infinity` when unlimited). */
  maxMemory: number;
  /** Bytes still available under `maxMemory`. */
  availableMemory: number;
  fileCount: number;
  directoryCount: number;
  symlinkCount: number;
  /** All nodes, including the root directory. */
  nodeCount: number;
  maxNodes: number;
}

/** Tracks content bytes and node counts and enforces limits before writes commit. */
export class MemoryManager {
  usedBytes = 0;
  allocatedBytes = 0;
  files = 0;
  directories = 0;
  symlinks = 0;

  constructor(readonly limits: MemoryLimits) {}

  get nodeCount(): number {
    return this.files + this.directories + this.symlinks;
  }

  /** Throw ENOSPC if growing content by `delta` bytes would exceed the limit. */
  reserve(delta: number, syscall: string, path?: string): void {
    if (delta > 0 && this.usedBytes + delta > this.limits.maxMemory) {
      throw errnoError("ENOSPC", {
        syscall,
        path,
        detail: `memspace maxMemory of ${this.limits.maxMemory} bytes exceeded: ${this.usedBytes} used, ${delta} requested`,
      });
    }
  }

  /** Throw ENOSPC if adding `count` nodes would exceed `maxNodes`. */
  reserveNodes(count: number, syscall: string, path?: string): void {
    if (this.nodeCount + count > this.limits.maxNodes) {
      throw errnoError("ENOSPC", {
        syscall,
        path,
        detail: `memspace maxNodes of ${this.limits.maxNodes} exceeded`,
      });
    }
  }

  adjust(usedDelta: number, allocatedDelta: number): void {
    this.usedBytes += usedDelta;
    this.allocatedBytes += allocatedDelta;
  }

  track(node: FsNode): void {
    if (node.type === "file") this.files++;
    else if (node.type === "directory") this.directories++;
    else this.symlinks++;
    this.usedBytes += contentBytes(node);
    this.allocatedBytes += capacityBytes(node);
  }

  untrack(node: FsNode): void {
    if (node.type === "file") this.files--;
    else if (node.type === "directory") this.directories--;
    else this.symlinks--;
    this.usedBytes -= contentBytes(node);
    this.allocatedBytes -= capacityBytes(node);
  }

  reset(): void {
    this.usedBytes = 0;
    this.allocatedBytes = 0;
    this.files = 0;
    this.directories = 0;
    this.symlinks = 0;
  }

  stats(): MemoryStats {
    return {
      usedMemory: this.usedBytes,
      allocatedMemory: this.allocatedBytes,
      maxMemory: this.limits.maxMemory,
      availableMemory: Math.max(0, this.limits.maxMemory - this.usedBytes),
      fileCount: this.files,
      directoryCount: this.directories,
      symlinkCount: this.symlinks,
      nodeCount: this.nodeCount,
      maxNodes: this.limits.maxNodes,
    };
  }
}

/** Choose a new backing capacity for a file that must hold `needed` bytes. */
export function growCapacity(current: number, needed: number): number {
  if (needed <= current) return current;
  // Geometric growth amortises repeated appends; cap the spare at 8 MiB.
  const doubled = Math.max(64, current * 2);
  return Math.max(needed, Math.min(doubled, needed + 8 * 1024 * 1024));
}
