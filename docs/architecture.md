# Architecture

```text
src/
├── index.ts               Public entry: default instance, createFs, bound named exports
├── api/
│   ├── vfs.ts             VirtualFileSystem: sync + callback API, extensions (stats, TTL, snapshot, dispose)
│   ├── promises.ts        fs.promises and FileHandle
│   ├── dir.ts             Dir (opendir)
│   ├── watch.ts           WatchRegistry, FSWatcher, StatWatcher, promises.watch iterator
│   └── types.ts           Option and callback types
├── engine/
│   ├── engine.ts          FsEngine: inode registry, tree, path resolution, mutations, change events
│   └── memory.ts          MemoryManager: content/node accounting and limit checks
├── core/
│   ├── nodes.ts           File / directory / symlink node types
│   ├── path.ts            PathLike conversion, POSIX normalization
│   ├── flags.ts           String and numeric open-flag parsing
│   ├── encoding.ts        Data/encoding normalization
│   └── constants.ts       fs constants (host table) and mode bits
├── descriptors/fd-table.ts  Per-instance descriptor table, process-unique numbers
├── metadata/stats.ts      Stats, BigIntStats, Dirent
├── streams/streams.ts     ReadStream, WriteStream
├── lifecycle/ttl.ts       TtlManager (single unref'd timer)
├── snapshots/snapshot.ts  JSON/binary encode, decode, validation
├── errors/index.ts        Node-shaped errno and coded errors
└── adapters/
    ├── express.ts         memspace-fs/express
    └── testing.ts         memspace-fs/testing
```

## Layers

1. **Engine (`FsEngine`)** knows nothing about Node's calling conventions. It
   takes plain path strings, returns nodes, and throws errno errors. All of its
   operations are synchronous and run to completion, which makes every public
   operation atomic.
2. **API layer (`VirtualFileSystem`, `promises`, streams, watchers)** validates
   and normalizes arguments exactly like Node (`PathLike`, flags, modes,
   encodings, positions), maps results to `Stats`/`Dirent`/Buffers, and
   implements callback/promise delivery.
3. **Adapters** depend only on the public API.

## Data model

- Every node (`file`, `directory`, `symlink`) has an inode number, a `name`, a
  `parent` pointer, mode/uid/gid, four timestamps, an optional `expiresAt`, and
  an open-descriptor count. Nodes live in a per-instance `registry`
  (`Map<ino, node>`); directories hold `Map<name, node>` children.
- Files store content in a `Buffer` with spare capacity (geometric growth,
  capped at 8 MiB of slack) and a logical `size`, so appends are amortized O(1).
  Large shrinks release capacity.
- Callers never receive views of internal buffers; reads copy out and writes copy in.

## Path resolution

`FsEngine.locate()` walks components from the root (or the instance cwd),
keeping a stack of directories. `..` pops the stack (never past the root).
Symlinks are expanded by splicing their target's components into the remaining
path, which gives physical `..` semantics and natural creation through dangling
links. A hop counter raises `ELOOP` after 40. Trailing slashes force
resolution and a directory check. With `permissions: "owner"`, every traversed
directory needs `x`.

## Memory accounting

`MemoryManager` tracks logical content bytes (`usedMemory`), allocated bytes
and node counts. Every mutation that can grow content calls `reserve(delta)`
**before** modifying anything, so failures are clean. Unlinked-but-open files
stay accounted until their last descriptor closes.

## Async model

Callback and promise operations perform the engine call immediately and
deliver the outcome on a later tick (`process.nextTick` / promise settlement).
Argument errors are thrown synchronously by callback APIs (as Node does) and
become rejections in promise APIs. Watch events are queued with
`process.nextTick`, so listeners can safely touch the filesystem.

## Zero-disk guarantee

The only import from `node:fs` is the constants table (for platform-correct
`O_*` values). `tests/unit/zero-disk.test.ts` enforces this statically and
also runs the whole API with every `node:fs` function replaced by a throwing stub.

## Extension points

- New storage strategies would implement the engine's content operations
  (`writeAt`, `readAt`, `truncateFile`, `replaceContent`) differently, for
  example with chunked or shared buffers.
- Persistence adapters can be built on `snapshot()` / `restore()` without
  touching the engine.
