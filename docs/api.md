# API reference

## Entry points

| Import | Contents |
|---|---|
| `memspace-fs` | `default` (the package-level instance), `createFs`, `VirtualFileSystem`, every `fs` function bound to the default instance (`readFileSync`, `promises`, …), `Stats`, `BigIntStats`, `Dirent`, `Dir`, `ReadStream`, `WriteStream`, `FSWatcher`, `StatWatcher`, `FileHandle`, `constants`, `isErrnoException`, snapshot constants, and all option/result types. |
| `memspace-fs/express` | `expressMiddleware`, `serveStatic`, `MemspaceRequest`, plus re-exports of `createFs`, `VirtualFileSystem`. |
| `memspace-fs/testing` | `createFixture`, `populate`, `toTree`, `withFs`, plus re-exports. |

ESM and CommonJS are both supported (`require("memspace-fs").default` is the
default instance). Note that, as with any dual package, an instance created by
the ESM build is not `instanceof` the CJS build's class.

## `createFs(options?)` / `new VirtualFileSystem(options?)`

Creates an isolated filesystem. See the options table in the [README](../README.md#options).
Throws `RangeError` for invalid `maxMemory` / `maxNodes`.

## `fs`-compatible methods

Every instance implements the following, with Node's signatures and overloads
(see [compatibility.md](compatibility.md) for per-method semantics):

**Sync:** `accessSync appendFileSync chmodSync chownSync closeSync copyFileSync
cpSync existsSync fchmodSync fchownSync fdatasyncSync fstatSync fsyncSync
ftruncateSync futimesSync lchmodSync lchownSync lstatSync lutimesSync mkdirSync
mkdtempSync openSync opendirSync readFileSync readSync readdirSync readlinkSync
realpathSync realpathSync.native renameSync rmSync rmdirSync statSync
symlinkSync truncateSync unlinkSync utimesSync writeFileSync writeSync`

**Callback:** `access appendFile chmod chown close copyFile cp exists fchmod
fchown fdatasync fstat fsync ftruncate futimes lchmod lchown lstat lutimes
mkdir mkdtemp open opendir read readFile readdir readlink realpath
realpath.native rename rm rmdir stat symlink truncate unlink utimes write
writeFile`

**Streams and watchers:** `createReadStream createWriteStream watch watchFile unwatchFile`

**Promises:** `fs.promises.*`, see [compatibility.md](compatibility.md#promises).

**Properties:** `constants`, `F_OK`, `R_OK`, `W_OK`, `X_OK`, `Stats`,
`BigIntStats`, `Dirent`, `Dir`, `ReadStream`, `WriteStream`, `name`.

## Memspace extensions

| Method | Description |
|---|---|
| `getStats(): MemspaceStats` | `usedMemory`, `allocatedMemory`, `maxMemory`, `availableMemory`, `fileCount`, `directoryCount`, `symlinkCount`, `nodeCount`, `maxNodes`, `openFileDescriptors`, `watcherCount`, `name`, `disposed`. Counts Memspace-managed content only, not process memory. |
| `snapshot(options?)` | `{ format: "json" }` (default) → `MemspaceSnapshot` object; `{ format: "binary" }` → `Buffer`. |
| `restore(snapshot)` | Accepts a snapshot object, a JSON string, or the binary Buffer. Validates fully and checks limits first; replaces all content; invalidates open descriptors; keeps watchers. Throws `ERR_MEMSPACE_INVALID_SNAPSHOT` or `ENOSPC`. |
| `setTtl(path, ms \| null)` | Set, reset or clear an entry's TTL (does not follow symlinks). `EBUSY` for `/`. |
| `getTtl(path)` | Milliseconds remaining, or `null`. |
| `purgeExpired()` | Remove expired entries now; returns how many top-level entries were removed. |
| `cwd()` / `chdir(path)` | Per-instance working directory for relative paths. |
| `reset()` | Remove everything (root remains), invalidate descriptors. Instance stays usable. |
| `dispose()` / `[Symbol.dispose]()` | Release all data, descriptors, watchers (they emit `close`) and timers. Idempotent. Afterwards every method throws `ERR_MEMSPACE_DISPOSED`. |
| `isDisposed` | Boolean getter. |
| `ttl` option | Accepted by `writeFile`, `appendFile`, `mkdir` (applies to the directory it creates) and `createWriteStream`. |

## Snapshot format

```ts
interface MemspaceSnapshot {
  format: "memspace-snapshot";
  version: 1;
  createdAt: number;               // epoch ms
  entries: SnapshotEntry[];        // root first, parents before children
}
interface SnapshotEntry {
  path: string;                    // canonical absolute path
  type: "file" | "directory" | "symlink";
  mode: number; uid: number; gid: number;
  atimeMs: number; mtimeMs: number; ctimeMs: number; birthtimeMs: number;
  expiresAt?: number;              // absolute epoch ms
  content?: string;                // base64 (files)
  target?: string;                 // symlinks
}
```

Binary layout: `"MSPCSNAP"` (8 bytes) · uint32 BE version · uint32 BE header
length · UTF-8 JSON header (entries carry `offset`/`length` instead of
`content`) · concatenated content bytes.

## Express adapter

### `expressMiddleware(fs, options?)`

| Option | Default | |
|---|---|---|
| `attachToRequest` | `false` | Also set `req[property]`. |
| `property` | `"memspace"` | Request property name. |
| `localsKey` | `"memspace"` | `res.locals` key (always set). |

### `serveStatic(fs, options?)`

Serves GET/HEAD requests from the instance by streaming. Options: `root`
(`"/"`), `index` (`"index.html"`, or `false`), `fallthrough` (`true`; when
false, missing files get a 404), `contentTypes` (extra extension → type map).
Request paths cannot climb above `root`.

## Testing utilities

| Function | |
|---|---|
| `createFixture(fixture, options?)` | New instance populated from `{ path: content }`. Values: string/Uint8Array (file), `null` (empty dir), `{ symlink: target }`. |
| `populate(fs, fixture, root = "/")` | Populate an existing instance; relative keys resolve against `root`. |
| `toTree(fs, dir = "/", { binary? })` | Flatten a directory into a fixture-shaped object. |
| `withFs(fn, fixture?, options?)` | Run `fn` with a fresh instance, disposing it afterwards (even on throw). |

## Errors

| Code | Raised when |
|---|---|
| `ENOENT` | Missing path component or target. |
| `EEXIST` | Exclusive create, `mkdir`, `symlink` or `copyFile(EXCL)` on an existing path. |
| `EISDIR` | File operation on a directory. |
| `ENOTDIR` | Path component is not a directory, or a trailing `/` on a non-directory. |
| `ENOTEMPTY` | `rmdir`, or `rename` onto a non-empty directory. |
| `EACCES` | `permissions: "owner"` denies access, or `access(X_OK)` on a non-executable file. |
| `EBADF` | Unknown/closed descriptor, or descriptor opened without the needed access. |
| `EINVAL` | `readlink` on a non-link, `rename` into own subtree, `ftruncate` on a read-only fd. |
| `ENOSPC` | `maxMemory` / `maxNodes` would be exceeded. The message names the limit. |
| `ELOOP` | More than 40 symlink hops, or `O_NOFOLLOW` on a symlink. |
| `EBUSY` | Removing/renaming `/`. |
| `ENAMETOOLONG` | Name > 255 bytes or path > 4096 bytes. |
| `EMFILE` | `maxOpenFiles` reached. |
| `ENOTSUP` | `COPYFILE_FICLONE_FORCE`. |
| `ERR_FS_EISDIR`, `ERR_FS_CP_*` | `rm`/`cp` rules, as in Node. |
| `ERR_INVALID_ARG_TYPE`, `ERR_INVALID_ARG_VALUE`, `ERR_OUT_OF_RANGE`, `ERR_INVALID_URL_SCHEME` | Argument validation, as in Node. |
| `ERR_DIR_CLOSED` | Using a closed `Dir`. |
| `ERR_MEMSPACE_DISPOSED` | Any call on a disposed instance. |
| `ERR_MEMSPACE_INVALID_SNAPSHOT` | `restore()` input failed validation. |

`isErrnoException(value)` narrows to errno-style errors.
