#!/usr/bin/env node
/**
 * Benchmarks: native node:fs, native node:fs/promises, Memspace sync and
 * Memspace promises, on identical workloads. Run with `npm run bench` after
 * `npm run build`. Pass `--json` for machine-readable output.
 *
 * Numbers depend heavily on hardware, OS, filesystem and page cache state.
 * They are meant to locate bottlenecks, not to support marketing claims:
 * native results here largely measure the OS page cache, not a physical disk.
 */
import * as nodeFs from "node:fs";
import * as nodeFsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { createFs } from "../dist/index.js";

const FILES = 1000;
const SMALL = Buffer.alloc(1024, 97);
const LARGE = Buffer.alloc(16 * 1024 * 1024, 7);
const ROUNDS = Number(process.env.BENCH_ROUNDS ?? 5);

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** Each target provides an fs-like object, a sync/async flavour and a scratch root. */
function targets() {
  return [
    { name: "node:fs (sync)", kind: "sync", make: () => {
      const root = nodeFs.mkdtempSync(path.join(os.tmpdir(), "memspace-bench-"));
      return { fs: nodeFs, root, cleanup: () => nodeFs.rmSync(root, { recursive: true, force: true }) };
    } },
    { name: "node:fs/promises", kind: "async", make: () => {
      const root = nodeFs.mkdtempSync(path.join(os.tmpdir(), "memspace-bench-"));
      return { fs: { promises: nodeFsp }, root, cleanup: () => nodeFs.rmSync(root, { recursive: true, force: true }) };
    } },
    { name: "memspace (sync)", kind: "sync", make: () => {
      const fs = createFs();
      fs.mkdirSync("/bench");
      return { fs, root: "/bench", cleanup: () => fs.dispose() };
    } },
    { name: "memspace (promises)", kind: "async", make: () => {
      const fs = createFs();
      fs.mkdirSync("/bench");
      return { fs, root: "/bench", cleanup: () => fs.dispose() };
    } },
  ];
}

const j = path.posix.join;

/** Workloads: `setup` is untimed, `run` is timed. Each returns ops performed. */
const workloads = [
  {
    name: `create ${FILES} x 1 KiB files`,
    sync: (fs, r) => { for (let i = 0; i < FILES; i++) fs.writeFileSync(j(r, `f${i}`), SMALL); return FILES; },
    async: async (fs, r) => { for (let i = 0; i < FILES; i++) await fs.promises.writeFile(j(r, `f${i}`), SMALL); return FILES; },
  },
  {
    name: `sequential read ${FILES} files`,
    setupSync: (fs, r) => { for (let i = 0; i < FILES; i++) fs.writeFileSync(j(r, `f${i}`), SMALL); },
    setupAsync: async (fs, r) => { for (let i = 0; i < FILES; i++) await fs.promises.writeFile(j(r, `f${i}`), SMALL); },
    sync: (fs, r) => { for (let i = 0; i < FILES; i++) fs.readFileSync(j(r, `f${i}`)); return FILES; },
    async: async (fs, r) => { for (let i = 0; i < FILES; i++) await fs.promises.readFile(j(r, `f${i}`)); return FILES; },
  },
  {
    name: `sequential overwrite 1 file x ${FILES}`,
    sync: (fs, r) => { for (let i = 0; i < FILES; i++) fs.writeFileSync(j(r, "same"), SMALL); return FILES; },
    async: async (fs, r) => { for (let i = 0; i < FILES; i++) await fs.promises.writeFile(j(r, "same"), SMALL); return FILES; },
  },
  {
    name: "directory traversal (10x100 tree, recursive readdir + stat)",
    setupSync: (fs, r) => { for (let d = 0; d < 10; d++) { fs.mkdirSync(j(r, `d${d}`)); for (let f = 0; f < 100; f++) fs.writeFileSync(j(r, `d${d}`, `f${f}`), "x"); } },
    setupAsync: async (fs, r) => { for (let d = 0; d < 10; d++) { await fs.promises.mkdir(j(r, `d${d}`)); for (let f = 0; f < 100; f++) await fs.promises.writeFile(j(r, `d${d}`, `f${f}`), "x"); } },
    sync: (fs, r) => { const all = fs.readdirSync(r, { recursive: true }); for (const p of all) fs.statSync(j(r, p)); return all.length; },
    async: async (fs, r) => { const all = await fs.promises.readdir(r, { recursive: true }); for (const p of all) await fs.promises.stat(j(r, p)); return all.length; },
  },
  {
    name: "recursive deletion (10x100 tree)",
    setupSync: (fs, r) => { for (let d = 0; d < 10; d++) { fs.mkdirSync(j(r, "t", `d${d}`), { recursive: true }); for (let f = 0; f < 100; f++) fs.writeFileSync(j(r, "t", `d${d}`, `f${f}`), "x"); } },
    setupAsync: async (fs, r) => { for (let d = 0; d < 10; d++) { await fs.promises.mkdir(j(r, "t", `d${d}`), { recursive: true }); for (let f = 0; f < 100; f++) await fs.promises.writeFile(j(r, "t", `d${d}`, `f${f}`), "x"); } },
    sync: (fs, r) => { fs.rmSync(j(r, "t"), { recursive: true }); return 1011; },
    async: async (fs, r) => { await fs.promises.rm(j(r, "t"), { recursive: true }); return 1011; },
  },
  {
    name: "binary write + read 16 MiB",
    sync: (fs, r) => { fs.writeFileSync(j(r, "big"), LARGE); fs.readFileSync(j(r, "big")); return 2; },
    async: async (fs, r) => { await fs.promises.writeFile(j(r, "big"), LARGE); await fs.promises.readFile(j(r, "big")); return 2; },
  },
  {
    name: `concurrent async writes (${FILES} in parallel)`,
    sync: null,
    async: async (fs, r) => { await Promise.all(Array.from({ length: FILES }, (_, i) => fs.promises.writeFile(j(r, `c${i}`), SMALL))); return FILES; },
  },
];

async function measure(target, workload) {
  const fn = target.kind === "sync" ? workload.sync : workload.async;
  if (!fn) return null;
  const times = [];
  let ops = 0;
  for (let round = 0; round < ROUNDS; round++) {
    const { fs, root, cleanup } = target.make();
    try {
      if (target.kind === "sync") workload.setupSync?.(fs, root);
      else await workload.setupAsync?.(fs, root);
      globalThis.gc?.();
      const start = performance.now();
      ops = await fn(fs, root);
      times.push(performance.now() - start);
    } finally {
      cleanup();
    }
  }
  const ms = median(times);
  return { ms, opsPerSec: (ops / ms) * 1000 };
}

async function snapshotBench() {
  const fs = createFs();
  for (let i = 0; i < FILES; i++) fs.writeFileSync(`/s/f${i}`.replace("/s/", "/"), SMALL);
  const results = {};
  for (const format of ["json", "binary"]) {
    const times = [];
    let size = 0;
    for (let round = 0; round < ROUNDS; round++) {
      const start = performance.now();
      const snap = fs.snapshot({ format });
      times.push(performance.now() - start);
      size = format === "binary" ? snap.byteLength : JSON.stringify(snap).length;
    }
    const restoreTimes = [];
    const snap = fs.snapshot({ format });
    for (let round = 0; round < ROUNDS; round++) {
      const target = createFs();
      const start = performance.now();
      target.restore(snap);
      restoreTimes.push(performance.now() - start);
      target.dispose();
    }
    results[format] = { snapshotMs: median(times), restoreMs: median(restoreTimes), bytes: size };
  }
  fs.dispose();
  return results;
}

const results = [];
for (const workload of workloads) {
  const row = { workload: workload.name };
  for (const target of targets()) row[target.name] = await measure(target, workload);
  results.push(row);
}
const snapshots = await snapshotBench();

const env = {
  node: process.version,
  platform: `${process.platform} ${os.release()} ${process.arch}`,
  cpu: os.cpus()[0]?.model ?? "unknown",
  rounds: ROUNDS,
  date: new Date().toISOString().slice(0, 10),
};

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ env, results, snapshots }, null, 2));
} else {
  const names = targets().map((t) => t.name);
  const cell = (v) => (v ? `${v.ms.toFixed(2)} ms` : "—");
  console.log(`Node ${env.node} · ${env.platform} · ${env.cpu} · median of ${env.rounds} rounds · ${env.date}\n`);
  console.log(`| Workload | ${names.join(" | ")} |`);
  console.log(`|---|${names.map(() => "---:").join("|")}|`);
  for (const row of results) console.log(`| ${row.workload} | ${names.map((n) => cell(row[n])).join(" | ")} |`);
  console.log(`\nSnapshots of ${FILES} x 1 KiB files:\n`);
  console.log("| Format | snapshot() | restore() | size |\n|---|---:|---:|---:|");
  for (const [format, r] of Object.entries(snapshots)) {
    console.log(`| ${format} | ${r.snapshotMs.toFixed(2)} ms | ${r.restoreMs.toFixed(2)} ms | ${(r.bytes / 1024).toFixed(0)} KiB |`);
  }
}
