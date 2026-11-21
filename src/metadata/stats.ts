/**
 * `Stats`, `BigIntStats` and `Dirent` objects compatible with Node's.
 *
 * Fields that have no in-memory meaning get stable synthetic values:
 * `dev` is a constant virtual device id, `rdev` is 0, `blksize` is 4096 and
 * `blocks` is the number of 512-byte blocks needed for `size`.
 */
import { BLOCK_SIZE, S_IFDIR, S_IFLNK, S_IFMT, S_IFREG, VIRTUAL_DEVICE_ID } from "../core/constants.js";
import type { FsNode, NodeType } from "../core/nodes.js";
import { contentBytes } from "../core/nodes.js";

const typeBits: Record<NodeType, number> = { file: S_IFREG, directory: S_IFDIR, symlink: S_IFLNK };

abstract class StatsBase<T extends number | bigint> {
  abstract dev: T;
  abstract mode: T;

  isFile(): boolean {
    return (Number(this.mode) & S_IFMT) === S_IFREG;
  }
  isDirectory(): boolean {
    return (Number(this.mode) & S_IFMT) === S_IFDIR;
  }
  isSymbolicLink(): boolean {
    return (Number(this.mode) & S_IFMT) === S_IFLNK;
  }
  /** Always false: Memspace has no device nodes. */
  isBlockDevice(): boolean {
    return false;
  }
  /** Always false: Memspace has no device nodes. */
  isCharacterDevice(): boolean {
    return false;
  }
  /** Always false: Memspace has no FIFOs. */
  isFIFO(): boolean {
    return false;
  }
  /** Always false: Memspace has no sockets. */
  isSocket(): boolean {
    return false;
  }
}

export class Stats extends StatsBase<number> {
  dev: number;
  ino: number;
  mode: number;
  nlink: number;
  uid: number;
  gid: number;
  rdev: number;
  size: number;
  blksize: number;
  blocks: number;
  atimeMs: number;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
  atime: Date;
  mtime: Date;
  ctime: Date;
  birthtime: Date;

  /** @internal Use `fs.statSync()`; this constructor is not a stable API. */
  constructor(node: FsNode) {
    super();
    const size = contentBytes(node);
    this.dev = VIRTUAL_DEVICE_ID;
    this.ino = node.ino;
    this.mode = typeBits[node.type] | node.mode;
    this.nlink = node.type === "directory" ? 2 + countSubdirs(node) : node.detached ? 0 : 1;
    this.uid = node.uid;
    this.gid = node.gid;
    this.rdev = 0;
    this.size = size;
    this.blksize = BLOCK_SIZE;
    this.blocks = Math.ceil(size / 512);
    this.atimeMs = node.atimeMs;
    this.mtimeMs = node.mtimeMs;
    this.ctimeMs = node.ctimeMs;
    this.birthtimeMs = node.birthtimeMs;
    this.atime = new Date(node.atimeMs);
    this.mtime = new Date(node.mtimeMs);
    this.ctime = new Date(node.ctimeMs);
    this.birthtime = new Date(node.birthtimeMs);
  }
}

export class BigIntStats extends StatsBase<bigint> {
  dev: bigint;
  ino: bigint;
  mode: bigint;
  nlink: bigint;
  uid: bigint;
  gid: bigint;
  rdev: bigint;
  size: bigint;
  blksize: bigint;
  blocks: bigint;
  atimeMs: bigint;
  mtimeMs: bigint;
  ctimeMs: bigint;
  birthtimeMs: bigint;
  atimeNs: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  birthtimeNs: bigint;
  atime: Date;
  mtime: Date;
  ctime: Date;
  birthtime: Date;

  /** @internal */
  constructor(node: FsNode) {
    super();
    const s = new Stats(node);
    this.dev = BigInt(s.dev);
    this.ino = BigInt(s.ino);
    this.mode = BigInt(s.mode);
    this.nlink = BigInt(s.nlink);
    this.uid = BigInt(s.uid);
    this.gid = BigInt(s.gid);
    this.rdev = BigInt(s.rdev);
    this.size = BigInt(s.size);
    this.blksize = BigInt(s.blksize);
    this.blocks = BigInt(s.blocks);
    this.atimeMs = BigInt(Math.floor(s.atimeMs));
    this.mtimeMs = BigInt(Math.floor(s.mtimeMs));
    this.ctimeMs = BigInt(Math.floor(s.ctimeMs));
    this.birthtimeMs = BigInt(Math.floor(s.birthtimeMs));
    this.atimeNs = BigInt(Math.round(s.atimeMs * 1e6));
    this.mtimeNs = BigInt(Math.round(s.mtimeMs * 1e6));
    this.ctimeNs = BigInt(Math.round(s.ctimeMs * 1e6));
    this.birthtimeNs = BigInt(Math.round(s.birthtimeMs * 1e6));
    this.atime = s.atime;
    this.mtime = s.mtime;
    this.ctime = s.ctime;
    this.birthtime = s.birthtime;
  }
}

function countSubdirs(node: FsNode): number {
  if (node.type !== "directory") return 0;
  let count = 0;
  for (const child of node.children.values()) if (child.type === "directory") count++;
  return count;
}

export class Dirent<Name extends string | Buffer = string> {
  name: Name;
  /** Directory containing this entry. */
  parentPath: string;
  /** Alias of `parentPath` (deprecated in Node, kept for compatibility). */
  path: string;
  private readonly kind: NodeType;

  /** @internal */
  constructor(name: Name, kind: NodeType, parentPath: string) {
    this.name = name;
    this.kind = kind;
    this.parentPath = parentPath;
    this.path = parentPath;
  }

  isFile(): boolean {
    return this.kind === "file";
  }
  isDirectory(): boolean {
    return this.kind === "directory";
  }
  isSymbolicLink(): boolean {
    return this.kind === "symlink";
  }
  isBlockDevice(): boolean {
    return false;
  }
  isCharacterDevice(): boolean {
    return false;
  }
  isFIFO(): boolean {
    return false;
  }
  isSocket(): boolean {
    return false;
  }
}
