# Memspace

A Node.js-compatible, **zero-disk** virtual filesystem. Memspace gives you
isolated filesystem instances that live entirely in memory, with the familiar
`fs` API (sync, callback, promises, descriptors, streams, watchers), memory
quotas, TTLs, snapshots and an optional Express adapter.

```ts
import fs from "memspace-fs";

fs.mkdirSync("/app", { recursive: true }); // as with real fs, parent directories must exist
fs.writeFileSync("/app/config.json", JSON.stringify({ port: 3000, environment: "development" }));
console.log(fs.readFileSync("/app/config.json", "utf-8"));
```

> **Memspace is not persistent storage.** Everything is gone when the process
> exits or the instance is disposed. Use `snapshot()` if you need to save state,
> and store the result wherever you like.

## Contents

- [Installation](#installation)
- [Quick start](#quick-start)
- [Usage styles](#usage-styles)
- [Promises, callbacks, descriptors and streams](#promises-callbacks-descriptors-and-streams)
- [Memory limits](#memory-limits)
- [TTL](#ttl-time-to-live)
- [Isolation](#isolation)
- [Snapshots](#snapshot-and-restore)
- [Express integration](#express-integration)
- [Testing utilities](#testing-utilities)
- [Error handling](#error-handling)
- [Limitations](#limitations)
- Further docs: [API reference](docs/api.md) · [Compatibility matrix](docs/compatibility.md) · [Architecture](docs/architecture.md) · [Benchmarks](docs/benchmarks.md)

## Installation

```bash
npm install memspace-fs
```

Requires Node.js 22 or later (Node 20 reached end-of-life in April 2026). Ships ESM and CommonJS builds with full type
declarations. Zero runtime dependencies.

## Quick start

```ts
import { createFs } from "memspace-fs";

const fs = createFs({ name: "application", maxMemory: 64 * 1024 * 1024 });

fs.mkdirSync("/app/config", { recursive: true });
fs.writeFileSync("/app/config/settings.json", "hello");
console.log(fs.readFileSync("/app/config/settings.json", "utf-8")); // "hello"
console.log(fs.getStats()); // { usedMemory: 5, maxMemory: 67108864, fileCount: 1, ... }

fs.dispose(); // release everything
```

## Usage styles

### Native-style (default instance)

```ts
import fs from "memspace-fs";                       // a package-level default instance
import { readFileSync, writeFileSync } from "memspace-fs"; // functions bound to that same instance
```

The default instance is isolated from every instance created with `createFs()`.
Porting code is often just changing the import:

```diff
- import { readFileSync, writeFileSync, promises } from "node:fs";
+ import { readFileSync, writeFileSync, promises } from "memspace-fs";
```

### Instance-based

```ts
import { createFs, VirtualFileSystem } from "memspace-fs";

const a = createFs();                 // every call creates an independent filesystem
const b = new VirtualFileSystem({ cwd: "/work" });
```

Every method is pre-bound, so destructuring works: `const { readFileSync } = createFs()`.

#### Options

| Option | Default | Meaning |
|---|---|---|
| `name` | `"memspace-<n>"` | Label used in stats and errors. |
| `maxMemory` | `Infinity` | Max bytes of file content (and symlink targets). |
| `maxNodes` | `Infinity` | Max files + directories + symlinks (including root). |
| `maxOpenFiles` | `65536` | Max simultaneously open descriptors (`EMFILE`). |
| `cwd` | `"/"` | Working directory for relative paths (created if missing). |
| `uid` / `gid` | process uid/gid | Owner for new nodes. |
| `umask` | `0o022` | Cleared from new file/directory modes. |
| `permissions` | `"ignore"` | `"owner"` enforces owner/group/other mode bits. |
| `ttlCleanup` | `"timer"` | `"lazy"` reclaims expired entries only on access. |

## Promises, callbacks, descriptors and streams

```ts
const fs = createFs();

// fs.promises — same semantics as the sync API
await fs.promises.mkdir("/uploads", { recursive: true });
await fs.promises.writeFile("/uploads/file.txt", "Temporary content");
const text = await fs.promises.readFile("/uploads/file.txt", "utf-8");

// FileHandle
await using handle = await fs.promises.open("/uploads/file.txt", "r+");
await handle.write("T", 0);

// callbacks
fs.readFile("/uploads/file.txt", "utf8", (err, data) => { /* ... */ });

// descriptors
const fd = fs.openSync("/data.bin", "w+");
fs.writeSync(fd, Buffer.from([1, 2, 3]));
fs.readSync(fd, Buffer.alloc(3), 0, 3, 0);
fs.closeSync(fd);

// streams (backpressure, start/end, encoding, destroy — no temp files)
import { pipeline } from "node:stream/promises";
await pipeline(fs.createReadStream("/data.bin", { start: 1 }), fs.createWriteStream("/copy.bin"));
```

**Async timing.** Callback and promise operations execute atomically at call
time and deliver results on a later tick. Two concurrent writes can never
interleave inside a file, and `await Promise.all([...])` of many operations
behaves deterministically.

## Memory limits

```ts
const fs = createFs({ maxMemory: 1024 });
fs.writeFileSync("/a", Buffer.alloc(1000));
fs.writeFileSync("/b", Buffer.alloc(100)); // throws ENOSPC; nothing is written
```

- Limits are checked **before** a write commits. A rejected write leaves the
  file exactly as it was (no partial writes, no truncation).
- The error is `ENOSPC` (`no space left on device`) with a message that names
  the limit. Files are never silently discarded.
- Overwrites, truncation, `unlink`, `rm` and TTL expiry free memory. Files that
  are unlinked while still open keep counting until their last descriptor closes.

```ts
fs.getStats();
// {
//   usedMemory: 1000,        // logical bytes of content: what maxMemory limits
//   allocatedMemory: 1000,   // bytes allocated, including spare growth capacity
//   maxMemory: 1024, availableMemory: 24,
//   fileCount: 1, directoryCount: 1, symlinkCount: 0, nodeCount: 2, maxNodes: Infinity,
//   openFileDescriptors: 0, watcherCount: 0, name: "memspace-1", disposed: false
// }
```

These numbers cover only what Memspace stores. They are **not** the Node.js
process's memory usage; check `process.memoryUsage()` for that. Node object
overhead (around a few hundred bytes per node) is not counted.

## TTL (time-to-live)

TTL is a **Memspace extension**, not a native `fs` option:

```ts
fs.writeFileSync("/cache/data.json", data, { ttl: 30_000 });   // expire in 30 s
fs.mkdirSync("/tmp/session", { recursive: true, ttl: 60_000 }); // a whole directory
fs.createWriteStream("/tmp/upload", { ttl: 5_000 });
fs.setTtl("/some/file", 10_000);   // set or reset
fs.setTtl("/some/file", null);     // clear
fs.getTtl("/some/file");           // ms remaining, or null
fs.purgeExpired();                 // reclaim now; returns the count
```

Expired entries are invisible to every operation the moment they expire. With
`ttlCleanup: "timer"` (default) a single `unref()`'d timer also reclaims their
memory promptly. It never keeps your process alive. With `"lazy"`, memory is
reclaimed on access or `purgeExpired()`. A write without `ttl` keeps an
existing TTL. TTLs move with renames.

## Isolation

```ts
const userA = createFs();
const userB = createFs();
userA.writeFileSync("/data.txt", "A");
userB.writeFileSync("/data.txt", "B");
userA.readFileSync("/data.txt", "utf-8"); // "A"
userB.readFileSync("/data.txt", "utf-8"); // "B"
```

Each instance has its own root, inode registry, descriptor table, watchers,
limits, TTL timer and lifecycle. Descriptor numbers are unique process-wide, so
an fd from one instance is `EBADF` on another. `dispose()` affects only that instance.

## Snapshot and restore

```ts
const snapshot = fs.snapshot();                      // JSON-compatible object
const binary = fs.snapshot({ format: "binary" });    // compact Buffer

const restored = createFs();
restored.restore(snapshot);   // also accepts the Buffer or a JSON string
```

Snapshots contain the whole tree: file contents (binary-safe), symlinks, modes,
owners, timestamps and pending TTLs. `restore()` validates the snapshot
completely (format, version, canonical paths, parent ordering, types, content)
and checks it against the target's limits **before** replacing anything.
Malformed input throws `ERR_MEMSPACE_INVALID_SNAPSHOT`. Snapshots never touch
the disk; persisting one is up to you:

```ts
import { writeFile } from "node:fs/promises";
await writeFile("state.msnap", fs.snapshot({ format: "binary" })); // your choice, explicitly
```

## Express integration

Optional and dependency-free. It works with Express 4 and 5.

```ts
import express from "express";
import { createFs, expressMiddleware, serveStatic } from "memspace-fs/express";

const app = express();
const fs = createFs({ maxMemory: 64 * 1024 * 1024 });

app.use(expressMiddleware(fs));                       // exposes res.locals.memspace
app.use(expressMiddleware(fs, { attachToRequest: true, property: "space" })); // and req.space

app.get("/files", (req, res) => res.json(fs.readdirSync("/")));
app.use("/static", serveStatic(fs, { root: "/public" }));  // stream files out of Memspace

app.listen(3000);
```

- You choose the instance. Request-scoped filesystems are never created implicitly.
- A shared instance is **not** tenant isolation. Use one instance per tenant
  (e.g. a `Map<tenantId, VirtualFileSystem>`) if you need it.
- Concurrency: each operation is atomic, but multi-step read-modify-write
  sequences can interleave across `await` points between requests, the same as
  on a real disk.
- `req.memspace` and `res.locals.memspace` are typed via Express type augmentation.
  For a custom property, use `MemspaceRequest<Request, "space">`.
- After `fs.dispose()`, the middleware forwards a 503 `ERR_MEMSPACE_DISPOSED` error.

## Testing utilities

```ts
import { createFixture, toTree, withFs } from "memspace-fs/testing";

const fs = createFixture({
  "/app/config.json": '{"port":3000}',
  "/app/logo.png": new Uint8Array([0x89, 0x50]),
  "/app/empty-dir": null,
  "/app/current": { symlink: "/app/config.json" },
});
expect(toTree(fs, "/app")).toMatchSnapshot();

await withFs(async (fs) => { /* fresh instance, disposed afterwards */ }, { "/seed.txt": "x" });
```

## Error handling

Errors match Node's shape: `code`, `errno` (platform value), `syscall`, `path`,
`dest`, and the familiar message.

```ts
try {
  fs.readFileSync("/missing.txt");
} catch (error) {
  error.code;    // "ENOENT"
  error.syscall; // "open"
  error.message; // "ENOENT: no such file or directory, open '/missing.txt'"
}
```

Codes raised: `ENOENT EEXIST EISDIR ENOTDIR ENOTEMPTY EACCES EBADF EINVAL ENOSPC
ELOOP EBUSY ENAMETOOLONG EMFILE ENOTSUP`, plus Node's coded errors
(`ERR_INVALID_ARG_TYPE`, `ERR_FS_EISDIR`, …) and Memspace's own
`ERR_MEMSPACE_DISPOSED` and `ERR_MEMSPACE_INVALID_SNAPSHOT`. Argument
validation errors are thrown synchronously by callback APIs and become
rejections in the promise API, as in Node.

## Limitations

The full list, with reasons, is in the [compatibility matrix](docs/compatibility.md). In short:

- **POSIX semantics only**, Linux flavour. Windows path syntax (`C:\`,
  backslashes) is not interpreted. Where Linux and macOS differ (e.g. `unlink`
  on a directory: `EISDIR` vs `EPERM`), Memspace follows Linux.
- **No hard links** (`link`), devices, FIFOs or sockets. `statfs`, `glob`,
  `openAsBlob` and `readv`/`writev` are not implemented yet.
- **Permissions are not enforced by default.** Mode bits are stored and
  reported; opt into owner/group/other checks with `permissions: "owner"`.
- **Watchers are event-driven, not OS-backed.** They see every change made
  through that instance (and only those). `watchFile` doesn't poll.
- **Not an `fs` interceptor.** Third-party modules that import `node:fs`
  directly keep using the real disk. Pass a Memspace instance to code that
  accepts an injectable fs.
- Timestamps have millisecond resolution.

## License

MIT
