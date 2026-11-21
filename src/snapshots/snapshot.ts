/**
 * Snapshot export/import.
 *
 * Two interchangeable representations:
 * - JSON-compatible objects (`MemspaceSnapshot`), with file content base64-encoded;
 * - a compact binary container (`Buffer`): an 8-byte magic, a uint32 format
 *   version, a uint32 header length, a UTF-8 JSON header, then raw content bytes.
 *
 * Snapshots never touch the disk; callers decide where to store them.
 */
import { invalidSnapshot } from "../errors/index.js";
import type { DirectoryNode, FsNode, NodeType } from "../core/nodes.js";
import { fileView } from "../core/nodes.js";
import { MAX_NAME_LENGTH, splitComponents } from "../core/path.js";

export const SNAPSHOT_FORMAT = "memspace-snapshot";
export const SNAPSHOT_VERSION = 1;
const MAGIC = Buffer.from("MSPCSNAP", "ascii");

export interface SnapshotEntry {
  /** Canonical absolute path. The root (`"/"`) is always the first entry. */
  path: string;
  type: NodeType;
  mode: number;
  uid: number;
  gid: number;
  atimeMs: number;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
  /** Absolute expiry time (epoch ms) for entries with a TTL. */
  expiresAt?: number;
  /** Base64 file content (files only). */
  content?: string;
  /** Symlink target (symlinks only). */
  target?: string;
}

export interface MemspaceSnapshot {
  format: typeof SNAPSHOT_FORMAT;
  version: number;
  createdAt: number;
  entries: SnapshotEntry[];
}

/** Engine-independent decoded form, with content as Buffers. */
export interface DecodedEntry extends Omit<SnapshotEntry, "content"> {
  data?: Buffer;
}

export interface DecodedSnapshot {
  createdAt: number;
  entries: DecodedEntry[];
  contentBytes: number;
}

export function collectEntries(root: DirectoryNode, now: number): DecodedEntry[] {
  const out: DecodedEntry[] = [];
  const visit = (node: FsNode, path: string) => {
    if (node.expiresAt !== null && node.expiresAt <= now) return;
    const entry: DecodedEntry = {
      path,
      type: node.type,
      mode: node.mode,
      uid: node.uid,
      gid: node.gid,
      atimeMs: node.atimeMs,
      mtimeMs: node.mtimeMs,
      ctimeMs: node.ctimeMs,
      birthtimeMs: node.birthtimeMs,
    };
    if (node.expiresAt !== null) entry.expiresAt = node.expiresAt;
    if (node.type === "file") entry.data = Buffer.from(fileView(node));
    if (node.type === "symlink") entry.target = node.target;
    out.push(entry);
    if (node.type === "directory") {
      const names = [...node.children.keys()].sort();
      for (const name of names) visit(node.children.get(name)!, path === "/" ? `/${name}` : `${path}/${name}`);
    }
  };
  visit(root, "/");
  return out;
}

export function toJsonSnapshot(entries: DecodedEntry[], createdAt: number): MemspaceSnapshot {
  return {
    format: SNAPSHOT_FORMAT,
    version: SNAPSHOT_VERSION,
    createdAt,
    entries: entries.map(({ data, ...rest }) => (data ? { ...rest, content: data.toString("base64") } : rest)),
  };
}

export function toBinarySnapshot(entries: DecodedEntry[], createdAt: number): Buffer {
  let offset = 0;
  const chunks: Buffer[] = [];
  const header = {
    format: SNAPSHOT_FORMAT,
    version: SNAPSHOT_VERSION,
    createdAt,
    entries: entries.map(({ data, ...rest }) => {
      if (!data) return rest;
      const located = { ...rest, offset, length: data.byteLength };
      offset += data.byteLength;
      chunks.push(data);
      return located;
    }),
  };
  const headerBytes = Buffer.from(JSON.stringify(header), "utf8");
  const prefix = Buffer.alloc(16);
  MAGIC.copy(prefix, 0);
  prefix.writeUInt32BE(SNAPSHOT_VERSION, 8);
  prefix.writeUInt32BE(headerBytes.byteLength, 12);
  return Buffer.concat([prefix, headerBytes, ...chunks]);
}

const TYPES = new Set<NodeType>(["file", "directory", "symlink"]);
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(entry: Record<string, unknown>, key: string, index: number): number {
  const value = entry[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw invalidSnapshot(`entry ${index}: "${key}" must be a finite number`);
  }
  return value;
}

/** Decode and fully validate a snapshot in any supported representation. */
export function decodeSnapshot(input: unknown): DecodedSnapshot {
  if (typeof input === "string") {
    try {
      input = JSON.parse(input);
    } catch {
      throw invalidSnapshot("string input is not valid JSON");
    }
  }
  if (input instanceof Uint8Array) return decodeBinary(Buffer.from(input.buffer, input.byteOffset, input.byteLength));
  return decodeObject(input, (entry, index) => {
    if (entry.type !== "file") return undefined;
    const content = entry.content ?? "";
    if (typeof content !== "string" || !BASE64.test(content) || content.length % 4 !== 0) {
      throw invalidSnapshot(`entry ${index}: "content" must be a base64 string`);
    }
    return Buffer.from(content, "base64");
  });
}

function decodeBinary(buffer: Buffer): DecodedSnapshot {
  if (buffer.byteLength < 16 || !buffer.subarray(0, 8).equals(MAGIC)) throw invalidSnapshot("missing binary header");
  const version = buffer.readUInt32BE(8);
  if (version !== SNAPSHOT_VERSION) throw invalidSnapshot(`unsupported version ${version}`);
  const headerLength = buffer.readUInt32BE(12);
  if (16 + headerLength > buffer.byteLength) throw invalidSnapshot("truncated header");
  let header: unknown;
  try {
    header = JSON.parse(buffer.subarray(16, 16 + headerLength).toString("utf8"));
  } catch {
    throw invalidSnapshot("header is not valid JSON");
  }
  const body = buffer.subarray(16 + headerLength);
  return decodeObject(header, (entry, index) => {
    if (entry.type !== "file") return undefined;
    const offset = entry.offset;
    const length = entry.length;
    if (
      typeof offset !== "number" || typeof length !== "number" ||
      !Number.isInteger(offset) || !Number.isInteger(length) ||
      offset < 0 || length < 0 || offset + length > body.byteLength
    ) {
      throw invalidSnapshot(`entry ${index}: content range is out of bounds`);
    }
    return Buffer.from(body.subarray(offset, offset + length));
  });
}

function decodeObject(
  input: unknown,
  readContent: (entry: Record<string, unknown>, index: number) => Buffer | undefined,
): DecodedSnapshot {
  if (!isRecord(input)) throw invalidSnapshot("expected an object");
  if (input.format !== SNAPSHOT_FORMAT) throw invalidSnapshot(`"format" must be "${SNAPSHOT_FORMAT}"`);
  if (input.version !== SNAPSHOT_VERSION) throw invalidSnapshot(`unsupported version ${String(input.version)}`);
  if (!Array.isArray(input.entries) || input.entries.length === 0) throw invalidSnapshot('"entries" must be a non-empty array');
  const createdAt = typeof input.createdAt === "number" ? input.createdAt : 0;

  const seen = new Map<string, NodeType>();
  const entries: DecodedEntry[] = [];
  let contentBytes = 0;
  input.entries.forEach((raw: unknown, index: number) => {
    if (!isRecord(raw)) throw invalidSnapshot(`entry ${index} is not an object`);
    const { path, type } = raw;
    if (typeof path !== "string" || !path.startsWith("/") || path.includes("\u0000")) {
      throw invalidSnapshot(`entry ${index}: "path" must be an absolute path`);
    }
    const components = splitComponents(path);
    const canonical = `/${components.join("/")}`;
    if (canonical !== path) throw invalidSnapshot(`entry ${index}: path "${path}" is not canonical`);
    if (components.some((c) => Buffer.byteLength(c) > MAX_NAME_LENGTH)) throw invalidSnapshot(`entry ${index}: name too long`);
    if (typeof type !== "string" || !TYPES.has(type as NodeType)) throw invalidSnapshot(`entry ${index}: invalid "type"`);
    if (index === 0 && (path !== "/" || type !== "directory")) throw invalidSnapshot("first entry must be the root directory");
    if (index > 0 && path === "/") throw invalidSnapshot("duplicate root entry");
    if (seen.has(path)) throw invalidSnapshot(`duplicate path "${path}"`);
    if (index > 0) {
      const parent = `/${components.slice(0, -1).join("/")}`;
      if (seen.get(parent) !== "directory") throw invalidSnapshot(`entry ${index}: parent of "${path}" is not a preceding directory`);
    }
    seen.set(path, type as NodeType);

    const entry: DecodedEntry = {
      path,
      type: type as NodeType,
      mode: finiteNumber(raw, "mode", index) & 0o7777,
      uid: finiteNumber(raw, "uid", index),
      gid: finiteNumber(raw, "gid", index),
      atimeMs: finiteNumber(raw, "atimeMs", index),
      mtimeMs: finiteNumber(raw, "mtimeMs", index),
      ctimeMs: finiteNumber(raw, "ctimeMs", index),
      birthtimeMs: finiteNumber(raw, "birthtimeMs", index),
    };
    if (raw.expiresAt !== undefined) entry.expiresAt = finiteNumber(raw, "expiresAt", index);
    if (type === "symlink") {
      if (typeof raw.target !== "string" || raw.target.length === 0) throw invalidSnapshot(`entry ${index}: symlink needs a "target"`);
      entry.target = raw.target;
      contentBytes += Buffer.byteLength(raw.target);
    }
    const data = readContent(raw, index);
    if (data) {
      entry.data = data;
      contentBytes += data.byteLength;
    }
    entries.push(entry);
  });
  return { createdAt, entries, contentBytes };
}
