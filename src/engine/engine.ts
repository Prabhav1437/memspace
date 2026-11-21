/**
 * FsEngine: the in-memory filesystem core.
 *
 * The engine owns the inode registry and directory tree, performs path
 * resolution (including symlinks), enforces memory limits and (optionally)
 * owner permission bits, and emits change events for watchers. It knows
 * nothing about Node's calling conventions; the API layer in `src/api`
 * translates `fs`-style signatures into engine calls.
 *
 * All methods are synchronous. Asynchronous public APIs schedule engine calls
 * on later ticks, so every operation is atomic with respect to the others.
 */
import { errnoError, type ErrnoCode } from "../errors/index.js";
import {
  DEFAULT_DIR_MODE,
  DEFAULT_FILE_MODE,
  DEFAULT_SYMLINK_MODE,
  DEFAULT_UMASK,
  R_OK,
  W_OK,
  X_OK,
} from "../core/constants.js";
import type { OpenFlags } from "../core/flags.js";
import {
  EMPTY_BUFFER,
  fileView,
  type DirectoryNode,
  type FileNode,
  type FsNode,
  type SymlinkNode,
} from "../core/nodes.js";
import { MAX_NAME_LENGTH, MAX_PATH_LENGTH, hasTrailingSlash, joinPath, resolvePath, splitComponents } from "../core/path.js";
import { MemoryManager, growCapacity } from "./memory.js";

export type PermissionMode = "ignore" | "owner";

export interface EngineOptions {
  maxMemory: number;
  maxNodes: number;
  cwd: string;
  uid: number;
  gid: number;
  umask: number;
  permissions: PermissionMode;
}

export type ChangeType = "rename" | "change";

export interface ChangeEvent {
  type: ChangeType;
  /** Canonical absolute path of the entry that changed. */
  path: string;
}

export type ChangeListener = (event: ChangeEvent) => void;

/** Result of resolving a path whose final component may not exist yet. */
export interface Location {
  parent: DirectoryNode;
  name: string;
  node: FsNode | undefined;
  /** The path as the caller supplied it, for error messages. */
  input: string;
  trailingSlash: boolean;
}

const MAX_SYMLINK_HOPS = 40;

/** Structural type of a decoded snapshot entry (see src/snapshots). */
export interface DecodedEntryLike {
  path: string;
  type: "file" | "directory" | "symlink";
  mode: number;
  uid: number;
  gid: number;
  atimeMs: number;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
  expiresAt?: number;
  target?: string;
  data?: Buffer;
}

export class FsEngine {
  readonly registry = new Map<number, FsNode>();
  readonly memory: MemoryManager;
  readonly options: EngineOptions;
  root: DirectoryNode;
  cwd: string;

  private nextIno = 1;
  private readonly listeners = new Set<ChangeListener>();
  /** Nodes carrying a TTL. */
  readonly expiring = new Set<FsNode>();
  /** Removed nodes that still have open descriptors; their bytes stay accounted until closed. */
  private readonly orphans = new Set<FsNode>();
  /** Called whenever a TTL is added or changed, so the TTL manager can reschedule. */
  onTtlChange: (() => void) | undefined;
  /** Clock used for timestamps and TTL. Replaceable in tests. */
  now: () => number = Date.now;

  constructor(options: EngineOptions) {
    this.options = options;
    this.memory = new MemoryManager({ maxMemory: options.maxMemory, maxNodes: options.maxNodes });
    this.root = this.createRoot();
    this.cwd = "/";
    if (options.cwd !== "/") this.mkdir(options.cwd, { recursive: true });
    this.cwd = resolvePath("/", options.cwd);
  }

  // ---------------------------------------------------------------- events

  subscribe(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  private emit(type: ChangeType, path: string): void {
    if (this.listeners.size === 0) return;
    const event = { type, path };
    for (const listener of [...this.listeners]) listener(event);
  }

  // ----------------------------------------------------------- node basics

  private createRoot(): DirectoryNode {
    const now = this.now();
    const root: DirectoryNode = {
      ino: this.nextIno++,
      type: "directory",
      name: "",
      parent: null,
      mode: DEFAULT_DIR_MODE & ~DEFAULT_UMASK,
      uid: this.options.uid,
      gid: this.options.gid,
      atimeMs: now,
      mtimeMs: now,
      ctimeMs: now,
      birthtimeMs: now,
      expiresAt: null,
      openCount: 0,
      detached: false,
      children: new Map(),
    };
    this.registry.set(root.ino, root);
    this.memory.track(root);
    return root;
  }

  /** Canonical absolute path of an attached node. */
  pathOf(node: FsNode): string {
    if (node.parent === null) return "/";
    const parts: string[] = [];
    for (let current: FsNode | null = node; current && current.parent; current = current.parent) {
      parts.push(current.name);
    }
    return `/${parts.reverse().join("/")}`;
  }

  getNode(ino: number): FsNode | undefined {
    return this.registry.get(ino);
  }

  private baseFields(name: string, parent: DirectoryNode) {
    const now = this.now();
    return {
      ino: this.nextIno++,
      name,
      parent,
      uid: this.options.uid,
      gid: this.options.gid,
      atimeMs: now,
      mtimeMs: now,
      ctimeMs: now,
      birthtimeMs: now,
      expiresAt: null,
      openCount: 0,
      detached: false,
    };
  }

  private attach(parent: DirectoryNode, node: FsNode): void {
    parent.children.set(node.name, node);
    this.registry.set(node.ino, node);
    this.memory.track(node);
    this.touchDir(parent);
    this.emit("rename", this.pathOf(node));
  }

  private validateName(name: string, syscall: string, input: string): void {
    if (Buffer.byteLength(name) > MAX_NAME_LENGTH) throw errnoError("ENAMETOOLONG", { syscall, path: input });
  }

  createFile(parent: DirectoryNode, name: string, mode: number, input: string, syscall = "open"): FileNode {
    this.validateName(name, syscall, input);
    this.requireAccess(parent, W_OK | X_OK, syscall, input);
    this.memory.reserveNodes(1, syscall, input);
    const node: FileNode = {
      ...this.baseFields(name, parent),
      type: "file",
      mode: mode & 0o7777 & ~this.options.umask,
      content: EMPTY_BUFFER,
      size: 0,
    };
    this.attach(parent, node);
    return node;
  }

  createDirectory(parent: DirectoryNode, name: string, mode: number, input: string): DirectoryNode {
    this.validateName(name, "mkdir", input);
    this.requireAccess(parent, W_OK | X_OK, "mkdir", input);
    this.memory.reserveNodes(1, "mkdir", input);
    const node: DirectoryNode = {
      ...this.baseFields(name, parent),
      type: "directory",
      mode: mode & 0o7777 & ~this.options.umask,
      children: new Map(),
    };
    this.attach(parent, node);
    return node;
  }

  private createSymlink(parent: DirectoryNode, name: string, target: string, input: string): SymlinkNode {
    this.validateName(name, "symlink", input);
    this.requireAccess(parent, W_OK | X_OK, "symlink", input);
    this.memory.reserveNodes(1, "symlink", input);
    this.memory.reserve(Buffer.byteLength(target), "symlink", input);
    const node: SymlinkNode = {
      ...this.baseFields(name, parent),
      type: "symlink",
      mode: DEFAULT_SYMLINK_MODE,
      target,
    };
    this.attach(parent, node);
    return node;
  }

  private touchDir(dir: DirectoryNode): void {
    const now = this.now();
    dir.mtimeMs = now;
    dir.ctimeMs = now;
  }

  // ------------------------------------------------------------ permissions

  /** True if the configured identity may access `node` with `bits` (R_OK | W_OK | X_OK). */
  can(node: FsNode, bits: number): boolean {
    if (this.options.permissions === "ignore" || bits === 0) return true;
    let granted: number;
    if (node.uid === this.options.uid) granted = (node.mode >> 6) & 7;
    else if (node.gid === this.options.gid) granted = (node.mode >> 3) & 7;
    else granted = node.mode & 7;
    return (granted & bits) === bits;
  }

  requireAccess(node: FsNode, bits: number, syscall: string, input: string): void {
    if (!this.can(node, bits)) throw errnoError("EACCES", { syscall, path: input });
  }

  // ------------------------------------------------------------ resolution

  /** Child lookup that lazily expires TTL'd entries. */
  private child(dir: DirectoryNode, name: string): FsNode | undefined {
    const node = dir.children.get(name);
    if (node && node.expiresAt !== null && node.expiresAt <= this.now()) {
      this.removeNode(node);
      return undefined;
    }
    return node;
  }

  /**
   * Resolve `input` to its parent directory and final name. Intermediate
   * components must exist; the final one may be missing. Symlinks in
   * intermediate positions are always followed; the final one only when
   * `followLast` is set (or the path has a trailing slash).
   */
  locate(input: string, syscall: string, followLast: boolean, dest?: string): Location {
    if (input.length > MAX_PATH_LENGTH) throw errnoError("ENAMETOOLONG", { syscall, path: input, dest });
    const trailingSlash = hasTrailingSlash(input);
    const follow = followLast || trailingSlash;
    const absolute = input.startsWith("/") ? input : `${this.cwd}/${input}`;
    let parts = absolute.split("/").filter((part) => part !== "" && part !== ".");
    const stack: DirectoryNode[] = [this.root];
    let hops = 0;
    let index = 0;

    while (index < parts.length) {
      const part = parts[index]!;
      const dir = stack[stack.length - 1]!;
      const isLast = index === parts.length - 1;
      if (part === "..") {
        if (stack.length > 1) stack.pop();
        index++;
        continue;
      }
      this.requireAccess(dir, X_OK, syscall, input);
      const node = this.child(dir, part);
      if (!node) {
        if (isLast) return { parent: dir, name: part, node: undefined, input, trailingSlash };
        throw errnoError("ENOENT", { syscall, path: input, dest });
      }
      if (node.type === "symlink" && (!isLast || follow)) {
        if (++hops > MAX_SYMLINK_HOPS) throw errnoError("ELOOP", { syscall, path: input, dest });
        const target = node.target.split("/").filter((p) => p !== "" && p !== ".");
        if (node.target.startsWith("/")) stack.length = 1;
        parts = [...target, ...parts.slice(index + 1)];
        index = 0;
        continue;
      }
      if (isLast) return { parent: dir, name: part, node, input, trailingSlash };
      if (node.type !== "directory") throw errnoError("ENOTDIR", { syscall, path: input, dest });
      stack.push(node);
      index++;
    }
    // The path resolved to a directory on the stack (e.g. "/", "a/..").
    const dir = stack[stack.length - 1]!;
    return { parent: dir.parent ?? dir, name: dir.name, node: dir, input, trailingSlash };
  }

  /** Resolve a path that must exist. */
  lookup(input: string, syscall: string, followLast = true, dest?: string): FsNode {
    const loc = this.locate(input, syscall, followLast, dest);
    if (!loc.node) throw errnoError("ENOENT", { syscall, path: input, dest });
    if (loc.trailingSlash && loc.node.type !== "directory") {
      throw errnoError("ENOTDIR", { syscall, path: input, dest });
    }
    return loc.node;
  }

  lookupDirectory(input: string, syscall: string): DirectoryNode {
    const node = this.lookup(input, syscall);
    if (node.type !== "directory") throw errnoError("ENOTDIR", { syscall, path: input });
    return node;
  }

  realpath(input: string): string {
    return this.pathOf(this.lookup(input, "realpath"));
  }

  chdir(input: string): void {
    const node = this.lookupDirectory(input, "chdir");
    this.requireAccess(node, X_OK, "chdir", input);
    this.cwd = this.pathOf(node);
  }

  // ----------------------------------------------------------- directories

  /** mkdir; returns the first directory created when `recursive` (Node semantics). */
  mkdir(input: string, options: { recursive?: boolean; mode?: number } = {}): string | undefined {
    const mode = options.mode ?? DEFAULT_DIR_MODE;
    if (!options.recursive) {
      const loc = this.locate(input, "mkdir", false);
      if (loc.node) throw errnoError("EEXIST", { syscall: "mkdir", path: input });
      this.createDirectory(loc.parent, loc.name, mode, input);
      return undefined;
    }
    const components = splitComponents(resolvePath(this.cwd, input));
    let dir = this.root;
    let current = "";
    let first: string | undefined;
    for (let i = 0; i < components.length; i++) {
      const name = components[i]!;
      current += `/${name}`;
      let node = this.child(dir, name);
      if (node?.type === "symlink") {
        const loc = this.locate(current, "mkdir", true);
        node = loc.node;
        if (!node) throw errnoError("EEXIST", { syscall: "mkdir", path: input });
      }
      if (!node) {
        dir = this.createDirectory(dir, name, mode, input);
        first ??= current;
        continue;
      }
      if (node.type !== "directory") {
        throw errnoError(i === components.length - 1 ? "EEXIST" : "ENOTDIR", { syscall: "mkdir", path: input });
      }
      dir = node;
    }
    return first;
  }

  /** Directory entries, sorted by name. */
  readdir(input: string): Array<[string, FsNode]> {
    const dir = this.lookupDirectory(input, "scandir");
    this.requireAccess(dir, R_OK, "scandir", input);
    dir.atimeMs = this.now();
    return this.entries(dir);
  }

  entries(dir: DirectoryNode): Array<[string, FsNode]> {
    const now = this.now();
    const result: Array<[string, FsNode]> = [];
    for (const [name, node] of dir.children) {
      if (node.expiresAt !== null && node.expiresAt <= now) {
        this.removeNode(node);
        continue;
      }
      result.push([name, node]);
    }
    return result.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  }

  rmdir(input: string): void {
    const loc = this.locate(input, "rmdir", false);
    const node = loc.node;
    if (!node) throw errnoError("ENOENT", { syscall: "rmdir", path: input });
    if (node.type !== "directory") throw errnoError("ENOTDIR", { syscall: "rmdir", path: input });
    if (node === this.root) throw errnoError("EBUSY", { syscall: "rmdir", path: input });
    if (node.children.size > 0 && this.entries(node).length > 0) {
      throw errnoError("ENOTEMPTY", { syscall: "rmdir", path: input });
    }
    this.requireAccess(loc.parent, W_OK | X_OK, "rmdir", input);
    this.removeNode(node);
  }

  // ----------------------------------------------------------------- files

  /** Open (and possibly create/truncate) a path; returns the node to bind to a descriptor. */
  open(input: string, flags: OpenFlags, mode = DEFAULT_FILE_MODE, syscall = "open"): FileNode | DirectoryNode {
    if (flags.create && flags.exclusive) {
      const existing = this.locate(input, syscall, false);
      if (existing.node) throw errnoError("EEXIST", { syscall, path: input });
    }
    const loc = this.locate(input, syscall, !flags.noFollow);
    let node = loc.node;
    if (!node) {
      if (!flags.create) throw errnoError("ENOENT", { syscall, path: input });
      if (loc.trailingSlash) throw errnoError("EISDIR", { syscall, path: input });
      return this.createFile(loc.parent, loc.name, mode, input, syscall);
    }
    if (node.type === "symlink") throw errnoError("ELOOP", { syscall, path: input });
    if (node.type === "directory") {
      if (flags.writable) throw errnoError("EISDIR", { syscall, path: input });
      this.requireAccess(node, R_OK, syscall, input);
      return node;
    }
    if (loc.trailingSlash || flags.directory) throw errnoError("ENOTDIR", { syscall, path: input });
    this.requireAccess(node, (flags.readable ? R_OK : 0) | (flags.writable ? W_OK : 0), syscall, input);
    if (flags.truncate && flags.writable && node.size > 0) this.truncateFile(node, 0, syscall, input);
    return node;
  }

  /** Replace a file's entire content atomically (memory is checked before anything changes). */
  replaceContent(node: FileNode, data: Buffer, syscall: string, input?: string): void {
    this.memory.reserve(data.byteLength - node.size, syscall, input);
    const content = Buffer.allocUnsafe(data.byteLength);
    data.copy(content);
    this.memory.adjust(data.byteLength - node.size, content.byteLength - node.content.byteLength);
    node.content = content;
    node.size = data.byteLength;
    this.touchFile(node);
  }

  /**
   * Write `data` into a file at `position` (or at the end when null).
   * Memory is reserved before any byte changes, so a failed write leaves the file untouched.
   */
  writeAt(node: FileNode, data: Buffer, position: number | null, syscall = "write", input?: string): number {
    const start = position === null ? node.size : position;
    const end = start + data.byteLength;
    if (end > node.size) this.memory.reserve(end - node.size, syscall, input);
    if (end > node.content.byteLength) this.resize(node, growCapacity(node.content.byteLength, end));
    if (start > node.size) node.content.fill(0, node.size, start);
    data.copy(node.content, start);
    if (end > node.size) {
      this.memory.adjust(end - node.size, 0);
      node.size = end;
    }
    this.touchFile(node);
    return data.byteLength;
  }

  /** Copy up to `length` bytes from `position` into `target`; returns bytes read. */
  readAt(node: FileNode, target: Uint8Array, offset: number, length: number, position: number): number {
    if (position >= node.size || length === 0) return 0;
    const count = Math.min(length, node.size - position);
    target.set(node.content.subarray(position, position + count), offset);
    node.atimeMs = this.now();
    return count;
  }

  /** Copy of a file's content. */
  readContent(node: FileNode): Buffer {
    node.atimeMs = this.now();
    return Buffer.from(fileView(node));
  }

  truncateFile(node: FileNode, length: number, syscall = "ftruncate", input?: string): void {
    if (length > node.size) {
      this.memory.reserve(length - node.size, syscall, input);
      if (length > node.content.byteLength) this.resize(node, length);
      node.content.fill(0, node.size, length);
    } else if (node.content.byteLength > length * 2 + 4096) {
      // Release spare capacity when a file shrinks substantially.
      const content = Buffer.allocUnsafe(length);
      node.content.copy(content, 0, 0, length);
      this.memory.adjust(0, content.byteLength - node.content.byteLength);
      node.content = content;
    }
    this.memory.adjust(length - node.size, 0);
    node.size = length;
    this.touchFile(node);
  }

  private resize(node: FileNode, capacity: number): void {
    const content = Buffer.allocUnsafe(capacity);
    node.content.copy(content, 0, 0, node.size);
    this.memory.adjust(0, capacity - node.content.byteLength);
    node.content = content;
  }

  private touchFile(node: FileNode): void {
    const now = this.now();
    node.mtimeMs = now;
    node.ctimeMs = now;
    if (!node.detached) this.emit("change", this.pathOf(node));
  }

  unlink(input: string): void {
    const loc = this.locate(input, "unlink", false);
    const node = loc.node;
    if (!node) throw errnoError("ENOENT", { syscall: "unlink", path: input });
    if (node.type === "directory") throw errnoError("EISDIR", { syscall: "unlink", path: input });
    if (loc.trailingSlash) throw errnoError("ENOTDIR", { syscall: "unlink", path: input });
    this.requireAccess(loc.parent, W_OK | X_OK, "unlink", input);
    this.removeNode(node);
  }

  /** `rm` semantics (Node's rmSync): lstat, then unlink or recursive removal. */
  rm(input: string, options: { recursive?: boolean; force?: boolean }): "removed" | "missing" | "directory" {
    let loc: Location;
    try {
      loc = this.locate(input, "lstat", false);
    } catch (error) {
      if (options.force && (error as { code?: string }).code === "ENOENT") return "missing";
      throw error;
    }
    const node = loc.node;
    if (!node) {
      if (options.force) return "missing";
      throw errnoError("ENOENT", { syscall: "lstat", path: input });
    }
    if (node.type === "directory") {
      if (!options.recursive) return "directory";
      if (node === this.root) throw errnoError("EBUSY", { syscall: "rm", path: input });
      this.requireTreeAccess(node, input);
    }
    this.requireAccess(loc.parent, W_OK | X_OK, "rm", input);
    this.removeNode(node);
    return "removed";
  }

  private requireTreeAccess(dir: DirectoryNode, input: string): void {
    if (this.options.permissions === "ignore") return;
    this.requireAccess(dir, R_OK | W_OK | X_OK, "rm", input);
    for (const child of dir.children.values()) {
      if (child.type === "directory") this.requireTreeAccess(child, input);
    }
  }

  /** Detach a node (and its subtree) from the tree and release its accounting. */
  removeNode(node: FsNode): void {
    const parent = node.parent;
    if (!parent) return;
    const path = this.pathOf(node);
    parent.children.delete(node.name);
    this.touchDir(parent);
    this.release(node, path);
  }

  private release(node: FsNode, path: string): void {
    if (node.type === "directory") {
      for (const child of node.children.values()) this.release(child, joinPath(path, child.name));
      node.children.clear();
    }
    node.detached = true;
    node.parent = null;
    this.registry.delete(node.ino);
    this.expiring.delete(node);
    if (node.openCount > 0) this.orphans.add(node);
    else this.memory.untrack(node);
    this.emit("rename", path);
  }

  /** Called when a descriptor referencing `node` is closed. */
  closeNode(node: FsNode): void {
    node.openCount = Math.max(0, node.openCount - 1);
    if (node.openCount === 0 && this.orphans.delete(node)) this.memory.untrack(node);
  }

  // ---------------------------------------------------------------- rename

  rename(from: string, to: string): void {
    const src = this.locate(from, "rename", false, to);
    const node = src.node;
    if (!node) throw errnoError("ENOENT", { syscall: "rename", path: from, dest: to });
    if (node === this.root) throw errnoError("EBUSY", { syscall: "rename", path: from, dest: to });
    if (src.trailingSlash && node.type !== "directory") {
      throw errnoError("ENOTDIR", { syscall: "rename", path: from, dest: to });
    }
    const dst = this.locate(to, "rename", false, to);
    if (dst.node === node) return;
    const fail = (code: ErrnoCode) => errnoError(code, { syscall: "rename", path: from, dest: to });
    if (dst.trailingSlash && node.type !== "directory") throw fail("ENOTDIR");
    if (node.type === "directory") {
      for (let dir: DirectoryNode | null = dst.parent; dir; dir = dir.parent) {
        if (dir === node) throw fail("EINVAL");
      }
      if (dst.node) {
        if (dst.node.type !== "directory") throw fail("ENOTDIR");
        if (this.entries(dst.node).length > 0) throw fail("ENOTEMPTY");
      }
    } else if (dst.node?.type === "directory") {
      throw fail("EISDIR");
    }
    this.requireAccess(src.parent, W_OK | X_OK, "rename", from);
    this.requireAccess(dst.parent, W_OK | X_OK, "rename", to);
    this.validateName(dst.name, "rename", to);

    const oldPath = this.pathOf(node);
    if (dst.node) this.removeNode(dst.node);
    src.parent.children.delete(node.name);
    this.touchDir(src.parent);
    node.name = dst.name;
    node.parent = dst.parent;
    dst.parent.children.set(dst.name, node);
    this.touchDir(dst.parent);
    node.ctimeMs = this.now();
    this.emit("rename", oldPath);
    this.emit("rename", this.pathOf(node));
  }

  // -------------------------------------------------------------- symlinks

  symlink(target: string, input: string): void {
    const loc = this.locate(input, "symlink", false, input);
    if (loc.node) throw errnoError("EEXIST", { syscall: "symlink", path: target, dest: input });
    this.createSymlink(loc.parent, loc.name, target, input);
  }

  readlink(input: string): string {
    const node = this.lookup(input, "readlink", false);
    if (node.type !== "symlink") throw errnoError("EINVAL", { syscall: "readlink", path: input });
    return node.target;
  }

  // ------------------------------------------------------------------ copy

  copyFile(from: string, to: string, exclusive: boolean): void {
    const source = this.lookup(from, "copyfile", true, to);
    if (source.type === "directory") throw errnoError("EISDIR", { syscall: "copyfile", path: from, dest: to });
    if (source.type !== "file") throw errnoError("EINVAL", { syscall: "copyfile", path: from, dest: to });
    this.requireAccess(source, R_OK, "copyfile", from);
    const loc = this.locate(to, "copyfile", true, to);
    let target = loc.node;
    if (target) {
      if (exclusive) throw errnoError("EEXIST", { syscall: "copyfile", path: from, dest: to });
      if (target.type === "directory") throw errnoError("EISDIR", { syscall: "copyfile", path: from, dest: to });
      if (target === source) return;
    } else {
      this.memory.reserve(source.size, "copyfile", to);
      target = this.createFile(loc.parent, loc.name, source.mode, to, "copyfile");
      target.mode = source.mode;
    }
    if (target.type !== "file") throw errnoError("EINVAL", { syscall: "copyfile", path: from, dest: to });
    this.replaceContent(target, fileView(source), "copyfile", to);
  }

  // -------------------------------------------------------------- metadata

  chmod(node: FsNode, mode: number): void {
    node.mode = mode & 0o7777;
    node.ctimeMs = this.now();
    this.emitMeta(node);
  }

  chown(node: FsNode, uid: number, gid: number): void {
    if (uid !== -1) node.uid = uid;
    if (gid !== -1) node.gid = gid;
    node.ctimeMs = this.now();
    this.emitMeta(node);
  }

  utimes(node: FsNode, atimeMs: number, mtimeMs: number): void {
    node.atimeMs = atimeMs;
    node.mtimeMs = mtimeMs;
    node.ctimeMs = this.now();
    this.emitMeta(node);
  }

  private emitMeta(node: FsNode): void {
    if (!node.detached) this.emit("change", this.pathOf(node));
  }

  access(input: string, mode: number): void {
    const node = this.lookup(input, "access");
    if (this.options.permissions === "ignore") {
      // Without permission enforcement, behave like a privileged user: R/W always
      // succeed and X succeeds if any execute bit (or the node is a directory).
      if (mode & X_OK && node.type === "file" && (node.mode & 0o111) === 0) {
        throw errnoError("EACCES", { syscall: "access", path: input });
      }
      return;
    }
    this.requireAccess(node, mode & 7, "access", input);
  }

  // ------------------------------------------------------------------- TTL

  setTtl(node: FsNode, ttlMs: number | null): void {
    if (ttlMs === null) {
      node.expiresAt = null;
      this.expiring.delete(node);
    } else {
      node.expiresAt = this.now() + ttlMs;
      this.expiring.add(node);
    }
    this.onTtlChange?.();
  }

  /** Earliest pending expiry, or null. */
  nextExpiry(): number | null {
    let next: number | null = null;
    for (const node of this.expiring) {
      if (node.expiresAt !== null && (next === null || node.expiresAt < next)) next = node.expiresAt;
    }
    return next;
  }

  /** Remove all expired entries; returns how many top-level entries were removed. */
  purgeExpired(): number {
    const now = this.now();
    let removed = 0;
    for (const node of [...this.expiring]) {
      if (node.expiresAt !== null && node.expiresAt <= now && !node.detached) {
        this.removeNode(node);
        removed++;
      }
    }
    return removed;
  }

  // ------------------------------------------------------------- snapshots

  /**
   * Replace the whole tree with pre-validated snapshot entries (parents first).
   * Limits must already have been checked by the caller.
   */
  importEntries(entries: ReadonlyArray<DecodedEntryLike>): void {
    this.reset();
    const dirs = new Map<string, DirectoryNode>([["/", this.root]]);
    const now = this.now();
    for (const entry of entries) {
      const meta = {
        mode: entry.mode,
        uid: entry.uid,
        gid: entry.gid,
        atimeMs: entry.atimeMs,
        mtimeMs: entry.mtimeMs,
        ctimeMs: entry.ctimeMs,
        birthtimeMs: entry.birthtimeMs,
        expiresAt: entry.expiresAt ?? null,
      };
      if (entry.path === "/") {
        Object.assign(this.root, meta, { expiresAt: null });
        continue;
      }
      if (meta.expiresAt !== null && meta.expiresAt <= now) continue;
      const slash = entry.path.lastIndexOf("/");
      const parent = dirs.get(slash === 0 ? "/" : entry.path.slice(0, slash));
      if (!parent) continue; // parent expired
      const name = entry.path.slice(slash + 1);
      const base = { ino: this.nextIno++, name, parent, openCount: 0, detached: false, ...meta };
      let node: FsNode;
      if (entry.type === "directory") {
        node = { ...base, type: "directory", children: new Map() };
        dirs.set(entry.path, node);
      } else if (entry.type === "symlink") {
        node = { ...base, type: "symlink", target: entry.target ?? "" };
      } else {
        const data = entry.data ?? EMPTY_BUFFER;
        node = { ...base, type: "file", content: data, size: data.byteLength };
      }
      parent.children.set(name, node);
      this.registry.set(node.ino, node);
      this.memory.track(node);
      if (node.expiresAt !== null) this.expiring.add(node);
    }
    this.onTtlChange?.();
    this.emit("rename", "/");
  }

  // ------------------------------------------------------------- lifecycle

  /** Drop every node and start over with an empty root. */
  reset(): void {
    this.registry.clear();
    this.expiring.clear();
    this.orphans.clear();
    this.memory.reset();
    this.root.children.clear();
    this.root = this.createRoot();
    this.cwd = "/";
    this.emit("rename", "/");
  }

  /** Release every reference held by the engine. */
  destroy(): void {
    this.listeners.clear();
    this.reset();
    this.listeners.clear();
    this.onTtlChange = undefined;
  }
}
