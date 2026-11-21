/**
 * Inode model.
 *
 * The filesystem is a tree of nodes held in a per-instance registry keyed by
 * inode number. Directories map child names to nodes; every node records its
 * parent directory and its own name, so a canonical path can be computed by
 * walking parent links. Hard links are intentionally not modelled (each node
 * has exactly one parent), which keeps rename/TTL/snapshot logic simple.
 */
export type NodeType = "file" | "directory" | "symlink";

export interface BaseNode {
  ino: number;
  type: NodeType;
  name: string;
  parent: DirectoryNode | null;
  /** Permission bits only (no S_IFMT type bits). */
  mode: number;
  uid: number;
  gid: number;
  atimeMs: number;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
  /** Absolute epoch ms when this node expires (Memspace TTL extension), or null. */
  expiresAt: number | null;
  /** Number of open file descriptors / handles referencing this node. */
  openCount: number;
  /** True once the node has been removed from the tree. */
  detached: boolean;
}

export interface FileNode extends BaseNode {
  type: "file";
  /** Backing store. Only the first `size` bytes are meaningful; the rest is spare capacity. */
  content: Buffer;
  size: number;
}

export interface DirectoryNode extends BaseNode {
  type: "directory";
  children: Map<string, FsNode>;
}

export interface SymlinkNode extends BaseNode {
  type: "symlink";
  target: string;
}

export type FsNode = FileNode | DirectoryNode | SymlinkNode;

export const EMPTY_BUFFER: Buffer = Buffer.alloc(0);

/** Bytes of file content held by a node (symlink targets count as content too). */
export function contentBytes(node: FsNode): number {
  if (node.type === "file") return node.size;
  if (node.type === "symlink") return Buffer.byteLength(node.target);
  return 0;
}

export function capacityBytes(node: FsNode): number {
  if (node.type === "file") return node.content.byteLength;
  if (node.type === "symlink") return Buffer.byteLength(node.target);
  return 0;
}

/** Live view of a file's bytes (do not leak to callers without copying). */
export function fileView(node: FileNode): Buffer {
  return node.content.subarray(0, node.size);
}
