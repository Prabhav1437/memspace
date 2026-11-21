import { errnoError } from "../errors/index.js";
import type { OpenFlags } from "../core/flags.js";
import type { DirectoryNode, FileNode } from "../core/nodes.js";

export interface OpenFile {
  fd: number;
  node: FileNode | DirectoryNode;
  flags: OpenFlags;
  /** Current file position for reads/writes without an explicit position. */
  position: number;
  /** Canonical path at open time (informational). */
  path: string;
}

/**
 * Descriptor numbers are drawn from a process-wide counter, so a descriptor
 * opened on one Memspace instance is never valid on another (EBADF instead of
 * silently touching a different instance's file). Tables themselves are
 * per instance. Numbers start high to avoid looking like real OS descriptors.
 */
let nextDescriptor = 1 << 20;

function allocateDescriptor(): number {
  const fd = nextDescriptor++;
  if (nextDescriptor >= 0x7fffffff) nextDescriptor = 1 << 20;
  return fd;
}

export class FdTable {
  private readonly open = new Map<number, OpenFile>();

  constructor(private readonly maxOpen: number) {}

  get size(): number {
    return this.open.size;
  }

  add(entry: Omit<OpenFile, "fd">, syscall: string, path: string): OpenFile {
    if (this.open.size >= this.maxOpen) throw errnoError("EMFILE", { syscall, path });
    let fd = allocateDescriptor();
    while (this.open.has(fd)) fd = allocateDescriptor();
    const file = { ...entry, fd };
    this.open.set(fd, file);
    return file;
  }

  get(fd: number, syscall: string): OpenFile {
    const file = this.open.get(fd);
    if (!file) throw errnoError("EBADF", { syscall });
    return file;
  }

  has(fd: number): boolean {
    return this.open.has(fd);
  }

  delete(fd: number): OpenFile | undefined {
    const file = this.open.get(fd);
    this.open.delete(fd);
    return file;
  }

  values(): IterableIterator<OpenFile> {
    return this.open.values();
  }

  clear(): void {
    this.open.clear();
  }
}
