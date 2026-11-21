import { describe, expect, it } from "vitest";
import { createFs } from "../../src/index.js";

describe("stress", () => {
  it("thousands of files across many directories", () => {
    const fs = createFs();
    for (let d = 0; d < 50; d++) {
      fs.mkdirSync(`/d${d}`);
      for (let f = 0; f < 200; f++) fs.writeFileSync(`/d${d}/f${f}.txt`, `${d}:${f}`);
    }
    expect(fs.getStats()).toMatchObject({ fileCount: 10_000, directoryCount: 51 });
    expect(fs.readdirSync("/d49")).toHaveLength(200);
    expect(fs.readFileSync("/d17/f123.txt", "utf8")).toBe("17:123");
    expect(fs.readdirSync("/", { recursive: true })).toHaveLength(10_050);
    fs.rmSync("/d0", { recursive: true });
    expect(fs.getStats().fileCount).toBe(9_800);
  });

  it("deep nesting", () => {
    const fs = createFs();
    const depth = 500;
    const path = `/${Array.from({ length: depth }, (_, i) => `n${i}`).join("/")}`;
    fs.mkdirSync(path, { recursive: true });
    fs.writeFileSync(`${path}/leaf`, "deep");
    expect(fs.readFileSync(`${path}/leaf`, "utf8")).toBe("deep");
    expect(fs.getStats().directoryCount).toBe(depth + 1);
    fs.rmSync("/n0", { recursive: true });
    expect(fs.getStats()).toMatchObject({ directoryCount: 1, fileCount: 0, usedMemory: 0 });
  });

  it("large binary content and repeated appends stay accurate", () => {
    const fs = createFs({ maxMemory: 64 * 1024 * 1024 });
    const chunk = Buffer.alloc(64 * 1024, 7);
    const fd = fs.openSync("/grow", "a");
    for (let i = 0; i < 512; i++) fs.writeSync(fd, chunk);
    fs.closeSync(fd);
    const stats = fs.getStats();
    expect(stats.usedMemory).toBe(32 * 1024 * 1024);
    expect(stats.allocatedMemory).toBeGreaterThanOrEqual(stats.usedMemory);
    expect(stats.allocatedMemory).toBeLessThanOrEqual(stats.usedMemory + 8 * 1024 * 1024);
    expect(fs.readFileSync("/grow").every((b) => b === 7)).toBe(true);
    fs.truncateSync("/grow", 10);
    expect(fs.getStats().allocatedMemory).toBe(10);
  });

  it("repeated overwrites do not leak accounting", () => {
    const fs = createFs({ maxMemory: 1024 * 1024 });
    for (let i = 0; i < 20_000; i++) fs.writeFileSync("/same", Buffer.alloc(i % 1000));
    expect(fs.getStats().usedMemory).toBe(19_999 % 1000);
  });

  it("memory limit is never exceeded under a flood of writes", () => {
    const limit = 256 * 1024;
    const fs = createFs({ maxMemory: limit });
    let rejected = 0;
    for (let i = 0; i < 5000; i++) {
      try {
        fs.writeFileSync(`/f${i % 300}`, Buffer.alloc((i * 37) % 2048));
      } catch (error) {
        expect((error as NodeJS.ErrnoException).code).toBe("ENOSPC");
        rejected++;
      }
      expect(fs.getStats().usedMemory).toBeLessThanOrEqual(limit);
    }
    expect(rejected).toBeGreaterThan(0);
  });

  it("snapshot/restore of a large tree", () => {
    const fs = createFs();
    for (let i = 0; i < 3000; i++) fs.writeFileSync(`/f${i}`, Buffer.alloc(100, i % 256));
    const binary = fs.snapshot({ format: "binary" });
    const restored = createFs();
    restored.restore(binary);
    expect(restored.getStats()).toMatchObject({ fileCount: 3000, usedMemory: 300_000 });
    expect(restored.readFileSync("/f2999")[0]).toBe(2999 % 256);
  });

  it("concurrent async workloads on many instances stay isolated", async () => {
    const instances = Array.from({ length: 20 }, (_, i) => createFs({ name: `tenant-${i}` }));
    await Promise.all(
      instances.map(async (fs, i) => {
        await fs.promises.mkdir("/data", { recursive: true });
        await Promise.all(Array.from({ length: 100 }, (_, j) => fs.promises.writeFile(`/data/${j}`, `${i}-${j}`)));
      }),
    );
    instances.forEach((fs, i) => {
      expect(fs.readdirSync("/data")).toHaveLength(100);
      expect(fs.readFileSync("/data/42", "utf8")).toBe(`${i}-42`);
    });
    instances.forEach((fs) => fs.dispose());
  });

  it("watchers are cleaned up after churn", () => {
    const fs = createFs();
    for (let i = 0; i < 1000; i++) fs.watch("/").close();
    for (let i = 0; i < 100; i++) {
      const listener = () => {};
      fs.watchFile("/x", listener);
      fs.unwatchFile("/x", listener);
    }
    expect(fs.getStats().watcherCount).toBe(0);
  });
});
