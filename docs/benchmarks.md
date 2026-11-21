# Benchmarks

Run them yourself:

```bash
npm run build && npm run bench          # markdown table
node benchmarks/run.mjs --json          # machine-readable
BENCH_ROUNDS=20 npm run bench           # more rounds
```

Each workload runs on a fresh target per round (untimed setup), and the median
is reported. Native targets use a fresh directory under `os.tmpdir()`.

## Caveats

- Native numbers mostly measure the OS page cache and syscall overhead, not a
  physical disk. Results vary widely across OS, filesystem (APFS, ext4, tmpfs)
  and hardware.
- Memspace numbers include JavaScript-level argument validation and `Stats`
  construction, but no I/O.
- These figures show where time goes. They are not a guarantee, and they say
  nothing about workloads they don't cover.

## Reference run

Node v26.9.0 · darwin 27.2.0 arm64 · Apple M4 · median of 5 rounds · 2026-11-21

| Workload | node:fs (sync) | node:fs/promises | memspace (sync) | memspace (promises) |
|---|---:|---:|---:|---:|
| create 1000 x 1 KiB files | 50.67 ms | 63.28 ms | 1.43 ms | 1.57 ms |
| sequential read 1000 files | 11.45 ms | 17.79 ms | 0.73 ms | 0.76 ms |
| sequential overwrite 1 file x 1000 | 24.76 ms | 34.33 ms | 0.86 ms | 1.17 ms |
| directory traversal (10x100 tree, recursive readdir + stat) | 2.48 ms | 7.29 ms | 0.99 ms | 0.83 ms |
| recursive deletion (10x100 tree) | 33.58 ms | 24.24 ms | 0.07 ms | 0.07 ms |
| binary write + read 16 MiB | 4.26 ms | 4.03 ms | 0.87 ms | 0.74 ms |
| concurrent async writes (1000 in parallel) | — | 20.65 ms | — | 1.57 ms |

Snapshots of 1000 x 1 KiB files:

| Format | snapshot() | restore() | size |
|---|---:|---:|---:|
| json | 0.74 ms | 1.86 ms | 1506 KiB |
| binary | 0.60 ms | 0.88 ms | 1187 KiB |

## Observations

- **Directory traversal plus `stat`** shows the smallest gap over native
  (about 2.5×). Each `Stats` object eagerly allocates four `Date`s, and
  `readdir` sorts its entries. Making the `Date` fields lazy (as Node does)
  is the obvious next optimization.
- **Large binary I/O** is bounded by `memcpy`: Memspace copies data in on
  write and out on read, which is what keeps internal buffers safe from callers.
- **Promise overhead** is small (one microtask per call), since no thread-pool
  hop is involved.
- **JSON snapshots** are about 27% larger than binary ones because of base64
  content encoding. Prefer binary for large trees.
