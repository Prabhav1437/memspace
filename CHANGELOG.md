# Changelog

All notable changes to this project are documented here. The project follows
[Semantic Versioning](https://semver.org/). Before 1.0.0, minor versions may
contain breaking changes.

## [0.1.0] - 2026-11-21

Initial release.

### Added

- Hierarchical in-memory engine: inode registry, directory tree, files, directories, symlinks.
- POSIX path resolution: `.`/`..` normalization, physical `..` after symlinks, `ELOOP` detection, per-instance `cwd`/`chdir`, no escape from the virtual root.
- Node-compatible sync, callback and promise APIs (including `FileHandle`), file descriptors, `Stats`/`BigIntStats`/`Dirent`, `Dir`, `cp`, `mkdtemp`, `opendir`.
- `createReadStream` / `createWriteStream` with ranges, encodings, backpressure and destruction.
- Event-driven `watch`, `promises.watch`, `watchFile` / `unwatchFile`.
- Node-shaped errors (`code`, `errno`, `syscall`, `path`, `dest`, message).
- Memory accounting and limits (`maxMemory`, `maxNodes`, `maxOpenFiles`), `getStats()`.
- TTL extension (`ttl` option, `setTtl`, `getTtl`, `purgeExpired`) with an unref'd cleanup timer.
- Optional owner/group/other permission enforcement.
- `snapshot()` / `restore()` in JSON and binary formats, with full validation.
- `reset()`, `dispose()`, `Symbol.dispose`.
- `memspace-fs/express` (`expressMiddleware`, `serveStatic`) and `memspace-fs/testing` (`createFixture`, `populate`, `toTree`, `withFs`).
- ESM and CommonJS builds with type declarations.
- Native-compatibility test suite, stress tests and benchmarks.
