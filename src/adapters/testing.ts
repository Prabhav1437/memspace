/**
 * Testing utilities (`memspace/testing`).
 *
 * ```ts
 * import { createFixture, toTree } from "memspace/testing";
 *
 * const fs = createFixture({
 *   "/app/config.json": JSON.stringify({ port: 3000 }),
 *   "/app/logo.png": Buffer.from([0x89, 0x50]),
 *   "/app/empty-dir": null,
 *   "/app/current": { symlink: "/app/config.json" },
 * });
 * expect(toTree(fs, "/app")).toEqual({ ... });
 * ```
 */
import { posix } from "node:path";
import { createFs, VirtualFileSystem } from "../index.js";
import type { MemspaceOptions } from "../api/types.js";

export { createFs, VirtualFileSystem };

/** A fixture value: file content, `null` for an empty directory, or a symlink. */
export type FixtureValue = string | Uint8Array | null | { symlink: string };
export type Fixture = Record<string, FixtureValue>;

/** Populate an instance from a flat `{ path: content }` map (parents are created automatically). */
export function populate(fs: VirtualFileSystem, fixture: Fixture, root = "/"): VirtualFileSystem {
  for (const [relative, value] of Object.entries(fixture)) {
    const path = posix.resolve(root, relative);
    if (value === null) {
      fs.mkdirSync(path, { recursive: true });
      continue;
    }
    fs.mkdirSync(posix.dirname(path), { recursive: true });
    if (typeof value === "object" && !(value instanceof Uint8Array)) fs.symlinkSync(value.symlink, path);
    else fs.writeFileSync(path, value);
  }
  return fs;
}

/** Create a new isolated instance pre-populated with `fixture`. */
export function createFixture(fixture: Fixture = {}, options?: MemspaceOptions): VirtualFileSystem {
  return populate(createFs(options), fixture);
}

/**
 * Flatten a directory into `{ relativePath: content }`, for snapshot-style
 * assertions. Text is decoded as UTF-8 unless `binary` is set; empty
 * directories map to `null`; symlinks map to `{ symlink: target }`.
 */
export function toTree(fs: VirtualFileSystem, dir = "/", options: { binary?: boolean } = {}): Record<string, FixtureValue> {
  const out: Record<string, FixtureValue> = {};
  const walk = (current: string, prefix: string) => {
    const entries = fs.readdirSync(current, { withFileTypes: true });
    if (entries.length === 0 && prefix !== "") out[prefix] = null;
    for (const entry of entries) {
      const full = posix.join(current, entry.name);
      const key = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(full, key);
      else if (entry.isSymbolicLink()) out[key] = { symlink: fs.readlinkSync(full) };
      else out[key] = options.binary ? fs.readFileSync(full) : fs.readFileSync(full, "utf8");
    }
  };
  walk(dir, "");
  return out;
}

/**
 * Run `fn` with a fresh instance and dispose it afterwards, even on failure.
 * Returns whatever `fn` returns.
 */
export async function withFs<T>(fn: (fs: VirtualFileSystem) => T | Promise<T>, fixture: Fixture = {}, options?: MemspaceOptions): Promise<T> {
  const fs = createFixture(fixture, options);
  try {
    return await fn(fs);
  } finally {
    fs.dispose();
  }
}
