/**
 * Zero-disk guarantee, checked two ways:
 * 1. statically: no source file imports node:fs / fs/promises except the
 *    constants table in src/core/constants.ts;
 * 2. at runtime: node:fs is mocked so every function throws, then the whole
 *    Memspace API surface is exercised.
 */
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const nativeCalls: string[] = vi.hoisted(() => []);

// Every function of node:fs (and node:fs/promises) records the call and throws.
// Only the `constants` table is passed through.
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  const stubbed: Record<string, unknown> = { constants: real.constants };
  for (const [key, value] of Object.entries(real)) {
    if (typeof value === "function") {
      stubbed[key] = (...args: unknown[]) => {
        nativeCalls.push(key);
        throw new Error(`native fs used: ${key}(${String(args[0])})`);
      };
    }
  }
  stubbed.promises = new Proxy({}, { get: (_t, key) => { nativeCalls.push(`promises.${String(key)}`); throw new Error("native fs.promises used"); } });
  return { ...stubbed, default: stubbed };
});
vi.mock("node:fs/promises", () => new Proxy({}, { get: (_t, key) => { nativeCalls.push(`fs/promises.${String(key)}`); throw new Error("native fs/promises used"); } }));

const { readdirSync, readFileSync } = await vi.importActual<typeof import("node:fs")>("node:fs");

const SRC = join(import.meta.dirname, "../../src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? sourceFiles(join(dir, entry.name)) : entry.name.endsWith(".ts") ? [join(dir, entry.name)] : [],
  );
}

describe("zero-disk guarantee", () => {
  it("only src/core/constants.ts imports from node:fs, and only `constants`", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, "utf8");
      const imports = [...text.matchAll(/^\s*(import|export)\b[^;]*?from\s+["'](node:)?fs(\/promises)?["']|require\(["'](node:)?fs["'\/]|import\(["'](node:)?fs/gm)];
      if (imports.length === 0) continue;
      const ok = file.endsWith(join("core", "constants.ts")) && /import \{ constants as hostConstants \} from "node:fs";/.test(text) && imports.length === 1;
      if (!ok) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it("runs the full API with every native fs function disabled", async () => {
    const { createFs } = await import("../../src/index.js");
    const fs = createFs({ maxMemory: 1 << 20 });
    fs.mkdirSync("/a/b", { recursive: true });
    fs.writeFileSync("/a/b/f.txt", "hello");
    fs.appendFileSync("/a/b/f.txt", " world");
    fs.copyFileSync("/a/b/f.txt", "/a/copy.txt");
    fs.cpSync("/a", "/c", { recursive: true });
    fs.renameSync("/a/copy.txt", "/a/moved.txt");
    fs.symlinkSync("/a/b", "/link");
    fs.readdirSync("/", { recursive: true, withFileTypes: true });
    fs.realpathSync("/link/f.txt");
    fs.statSync("/link");
    fs.lstatSync("/link");
    fs.existsSync("/nope");
    fs.chmodSync("/a/moved.txt", 0o600);
    fs.utimesSync("/a/moved.txt", 1, 2);
    const fd = fs.openSync("/fd.bin", "w+");
    fs.writeSync(fd, Buffer.from([1, 2, 3]));
    fs.readSync(fd, Buffer.alloc(3), 0, 3, 0);
    fs.ftruncateSync(fd, 1);
    fs.fstatSync(fd);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fs.mkdtempSync("/tmp-");
    const watcher = fs.watch("/", { recursive: true });
    await fs.promises.writeFile("/p.txt", "promised");
    await fs.promises.readFile("/p.txt", "utf8");
    const handle = await fs.promises.open("/p.txt", "r");
    await handle.readFile();
    await handle.close();
    await new Promise((resolve, reject) =>
      fs.createReadStream("/p.txt").pipe(fs.createWriteStream("/s.txt")).on("finish", resolve).on("error", reject),
    );
    await new Promise((resolve) => fs.readFile("/s.txt", resolve));
    fs.writeFileSync("/ttl", "x", { ttl: 10 });
    createFs().restore(fs.snapshot({ format: "binary" }));
    fs.rmSync("/a", { recursive: true });
    watcher.close();
    fs.dispose();
    expect(nativeCalls).toEqual([]);
  });
});
