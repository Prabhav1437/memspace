# Compatibility matrix

Memspace targets the Node.js `fs` API (Node 20+) with **POSIX semantics,
Linux flavour**. Behaviour is measured, not assumed: `tests/compatibility/native.test.ts`
runs 110 scenarios against both native `node:fs` (in a temp directory) and
Memspace, and requires identical return values, error codes, syscalls and
messages. Scenarios that differ by platform are marked and skipped on the
platform that diverges from Linux.

Legend: ✅ faithful · 🟡 adapted in-memory semantics (documented below) · ❌ not provided

## Files

| API | Sync | Callback | Promise | Status | Notes |
|---|:-:|:-:|:-:|:-:|---|
| readFile | ✅ | ✅ | ✅ | ✅ | Path or fd/FileHandle, `encoding`, `flag`, `signal` (promises). |
| writeFile | ✅ | ✅ | ✅ | ✅ | string / Buffer / TypedArray / DataView; promises also take (async) iterables. `flag`, `mode`, `encoding`, `ttl`*. `flush` accepted (no-op). |
| appendFile | ✅ | ✅ | ✅ | ✅ | |
| unlink | ✅ | ✅ | ✅ | ✅ | On a directory: `EISDIR` (Linux; macOS gives `EPERM`). |
| copyFile | ✅ | ✅ | ✅ | 🟡 | `COPYFILE_EXCL` ✅, `COPYFILE_FICLONE` copies, `COPYFILE_FICLONE_FORCE` → `ENOTSUP` (no copy-on-write). |
| cp | ✅ | ✅ | ✅ | 🟡 | `recursive`, `force`, `errorOnExist`, `filter` (sync only), `dereference`, `preserveTimestamps`. `verbatimSymlinks` ignored (symlinks are always copied verbatim). |
| rename | ✅ | ✅ | ✅ | ✅ | Atomic. Replace rules, `EINVAL` into own subtree, `ENOTEMPTY`, `EISDIR`/`ENOTDIR` as on Linux. |
| truncate / ftruncate | ✅ | ✅ | ✅ | ✅ | Zero-fills when extending. `ftruncate` on a read-only fd → `EINVAL`. |
| access | ✅ | ✅ | ✅ | 🟡 | See [Permissions](#permissions). |
| exists | ✅ | ✅ | — | ✅ | `existsSync` never throws. |

\* `ttl` is a Memspace extension.

## Directories

| API | Sync | Callback | Promise | Status | Notes |
|---|:-:|:-:|:-:|:-:|---|
| mkdir | ✅ | ✅ | ✅ | ✅ | `recursive` returns the first created path. `mode`, `ttl`*. |
| readdir | ✅ | ✅ | ✅ | 🟡 | `withFileTypes`, `recursive`, `encoding: "buffer"`. Entries are **sorted by name** (native order is filesystem-dependent). Dirents carry `parentPath`. |
| rmdir | ✅ | ✅ | ✅ | ✅ | Deprecated `recursive` option is supported. |
| rm | ✅ | ✅ | ✅ | ✅ | `recursive`, `force`; directory without `recursive` → `ERR_FS_EISDIR`. `maxRetries`/`retryDelay` accepted and ignored. Removing `/` → `EBUSY` (use `reset()`). |
| mkdtemp | ✅ | ✅ | ✅ | ✅ | 6 random characters, mode `0o700`. |
| opendir | ✅ | ✅ | ✅ | 🟡 | `Dir` with `read`, `readSync`, `close`, `closeSync`, async iteration, `recursive`. Entries are captured when opened. |

## Metadata

| API | Sync | Callback | Promise | Status | Notes |
|---|:-:|:-:|:-:|:-:|---|
| stat / lstat / fstat | ✅ | ✅ | ✅ | 🟡 | `bigint`, `throwIfNoEntry`. See [Stats fields](#stats-fields). |
| realpath (+ `.native`) | ✅ | ✅ | ✅ | ✅ | Errors report syscall `realpath` (Node's JS implementation reports `lstat`). |
| chmod / fchmod / lchmod | ✅ | ✅ | ✅ | ✅ | Number or octal string. `lchmod` is provided on all platforms. |
| chown / fchown / lchown | ✅ | ✅ | ✅ | ✅ | Any uid/gid is accepted (no privilege model); `-1` keeps the value. |
| utimes / futimes / lutimes | ✅ | ✅ | ✅ | ✅ | Seconds, numeric strings or `Date`. Millisecond resolution. |
| symlink / readlink | ✅ | ✅ | ✅ | ✅ | `type` accepted and ignored. Relative targets resolve from the link's directory. |
| link | ❌ | ❌ | ❌ | ❌ | Hard links are not modelled (each node has exactly one parent). |
| statfs | ❌ | ❌ | ❌ | ❌ | Planned: could report quota figures. |

## File descriptors

| API | Status | Notes |
|---|:-:|---|
| open / close | ✅ | All string flags (`r`, `r+`, `w`, `wx`, `a`, `ax+`, `rs+`, …) and numeric `O_*` flags (`O_CREAT`, `O_EXCL`, `O_TRUNC`, `O_APPEND`, `O_DIRECTORY`, `O_NOFOLLOW`). Directories can be opened read-only. |
| read / write | ✅ | All overloads (positional, options object, string with encoding). Writing past EOF zero-fills. In append mode positions are ignored (Linux semantics; macOS writes at the position). |
| fsync / fdatasync | 🟡 | Validate the descriptor; data is always "durable" in memory. |
| readv / writev | ❌ | Not yet implemented. |
| Descriptor numbers | 🟡 | Unique across all instances in the process (start at 2²⁰), so cross-instance use fails with `EBADF`. Files unlinked while open remain readable/writable until closed. |

## Promises

`fs.promises` mirrors `node:fs/promises`: `open` (→ `FileHandle`), `readFile`,
`writeFile`, `appendFile`, `access`, `copyFile`, `cp`, `rename`, `unlink`,
`truncate`, `mkdir`, `mkdtemp`, `readdir`, `opendir`, `rmdir`, `rm`, `stat`,
`lstat`, `realpath`, `symlink`, `readlink`, `chmod`, `lchmod`, `chown`,
`lchown`, `utimes`, `lutimes`, `watch`, `constants`.

`FileHandle`: `fd`, `read`, `write`, `readFile`, `writeFile`, `appendFile`,
`stat`, `truncate`, `sync`, `datasync`, `chmod`, `chown`, `utimes`,
`createReadStream`, `createWriteStream`, `readLines`, `close`,
`[Symbol.asyncDispose]`. Not provided: `readv`, `writev`, `readableWebStream`.

## Streams

| Feature | Status | Notes |
|---|:-:|---|
| `createReadStream` | ✅ | `start`/`end` (inclusive), `highWaterMark` (64 KiB), `encoding`, `fd`, `flags`, `mode`, `autoClose`, `emitClose`, `signal`. Emits `open`, `ready`, `close`; `bytesRead`, `path`, `pending`. |
| `createWriteStream` | ✅ | `start`, `flags`, `encoding`, `fd`, `mode`, `autoClose`, `emitClose`, `highWaterMark` (16 KiB), `signal`, `ttl`*. `bytesWritten`. Batched chunks (`_writev`) commit atomically under the memory limit. |
| Backpressure / destroy / errors | ✅ | Provided by Node's `stream.Readable`/`Writable`. |

## Watchers

| API | Status | Notes |
|---|:-:|---|
| `watch` | 🟡 | Event-driven from the engine: `rename`/`change` events, `recursive`, `encoding`, `signal`. Reports **every** change made through the instance, with no OS coalescing. Delivered on the next tick. Changes made by other instances or the real disk are never seen. |
| `promises.watch` | 🟡 | Async iterator; ends with `AbortError` on abort. |
| `watchFile` / `unwatchFile` | 🟡 | Event-driven (no polling; `interval` ignored). Listener receives `(current, previous)` stats; a missing file reports zeroed stats. |
| `persistent`, `ref()`, `unref()` | 🟡 | Accepted; watchers never hold the event loop open. |

## Stats fields

| Field | Value |
|---|---|
| `dev` | Constant virtual device id (`0x6d656d`). |
| `ino` | Unique per instance, stable across renames. |
| `mode` | Type bits (`S_IFREG`, `S_IFDIR`, `S_IFLNK`) + permission bits. |
| `nlink` | Files: 1 (0 once unlinked). Directories: 2 + subdirectories. |
| `uid`, `gid` | Owner as set by options / `chown`. |
| `rdev` | 0. |
| `size` | Content bytes (symlinks: target length). |
| `blksize`, `blocks` | 4096 and `ceil(size / 512)`. Synthetic. |
| `atime`/`mtime`/`ctime`/`birthtime` (+`Ms`, `Ns` for bigint) | Tracked per POSIX rules (reads update `atime`). |
| `isBlockDevice()`, `isCharacterDevice()`, `isFIFO()`, `isSocket()` | Always `false`: no such node types exist. |

## Permissions

`permissions: "ignore"` (default) behaves like a privileged user: mode bits are
stored and reported, `access()` succeeds for `R_OK`/`W_OK`, and `X_OK` on a file
requires some execute bit. `permissions: "owner"` enforces classic
owner/group/other bits for traversal (`x` on directories), reads, writes and
directory modification (`w`+`x` on the parent). There are no ACLs, no
sticky/setuid semantics and no privileged user.

## Paths

- POSIX only: `/` separator, single root. `..` at the root stays at the root.
  No path, symlink target or relative path can reach outside the instance.
- `..` after a symlink is resolved physically (like the OS), not lexically.
- Up to 40 symlink hops, then `ELOOP`. Names over 255 bytes → `ENAMETOOLONG`.
- Accepts strings, Buffers and `file:` URLs. Null bytes → `ERR_INVALID_ARG_VALUE`.
- Each instance has its own `cwd()` / `chdir()` (default `/`). `process.cwd()` is not used.

## Cannot meaningfully exist in memory

Hard links, device nodes, FIFOs, sockets, `statfs` disk geometry, `fs.openAsBlob`
(could be added), copy-on-write clones, OS-level file locking, cross-process
visibility, and interception of other modules' `node:fs` imports.

## Platform divergences (measured)

| Scenario | Linux / Memspace | macOS native |
|---|---|---|
| `unlink` a directory | `EISDIR` | `EPERM` |
| `writeFile("new/")` (missing, trailing slash) | `EISDIR` | `ENOENT` |
| `rename(file, "b/")` | `ENOTDIR` | `ENOENT` |
| Positional write on an `a` (append) descriptor | appends | writes at position |
