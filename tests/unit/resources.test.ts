import { afterEach, describe, expect, it, vi } from "vitest";
import { createFs } from "../../src/index.js";

describe("memory limits", () => {
  it("reports Memspace-managed usage", () => {
    const fs = createFs({ maxMemory: 1024 });
    fs.mkdirSync("/a/b", { recursive: true });
    fs.writeFileSync("/a/b/f", "12345");
    fs.symlinkSync("/a", "/l");
    expect(fs.getStats()).toMatchObject({
      usedMemory: 5 + 2,
      maxMemory: 1024,
      availableMemory: 1024 - 7,
      fileCount: 1,
      directoryCount: 3,
      symlinkCount: 1,
      nodeCount: 5,
      openFileDescriptors: 0,
    });
  });

  it("rejects writes that would exceed the limit without changing anything", () => {
    const fs = createFs({ maxMemory: 10 });
    fs.writeFileSync("/f", "12345678");
    expect(() => fs.writeFileSync("/f", "12345678901")).toThrow(expect.objectContaining({ code: "ENOSPC", syscall: "write", path: "/f" }));
    expect(fs.readFileSync("/f", "utf8")).toBe("12345678");
    expect(() => fs.appendFileSync("/f", "abc")).toThrow(expect.objectContaining({ code: "ENOSPC" }));
    expect(fs.readFileSync("/f", "utf8")).toBe("12345678");
    fs.appendFileSync("/f", "ab");
    expect(fs.getStats().usedMemory).toBe(10);
  });

  it("frees memory on overwrite, truncate, unlink and rm", () => {
    const fs = createFs({ maxMemory: 100 });
    fs.writeFileSync("/f", Buffer.alloc(90));
    fs.writeFileSync("/f", Buffer.alloc(10));
    fs.writeFileSync("/g", Buffer.alloc(90));
    fs.truncateSync("/g", 5);
    fs.writeFileSync("/h", Buffer.alloc(85));
    fs.unlinkSync("/h");
    fs.mkdirSync("/d");
    fs.writeFileSync("/d/x", Buffer.alloc(85));
    fs.rmSync("/d", { recursive: true });
    expect(fs.getStats().usedMemory).toBe(15);
  });

  it("enforces limits on descriptor writes, truncation, copies and streams", async () => {
    const fs = createFs({ maxMemory: 16 });
    const fd = fs.openSync("/f", "w");
    fs.writeSync(fd, Buffer.alloc(10));
    expect(() => fs.writeSync(fd, Buffer.alloc(10))).toThrow(expect.objectContaining({ code: "ENOSPC" }));
    expect(() => fs.ftruncateSync(fd, 100)).toThrow(expect.objectContaining({ code: "ENOSPC" }));
    expect(() => fs.writeSync(fd, "x", 100)).toThrow(expect.objectContaining({ code: "ENOSPC" }));
    fs.closeSync(fd);
    expect(() => fs.copyFileSync("/f", "/g")).toThrow(expect.objectContaining({ code: "ENOSPC" }));
    expect(fs.existsSync("/g")).toBe(false);

    const ws = fs.createWriteStream("/s");
    const error = await new Promise<NodeJS.ErrnoException>((resolve) => {
      ws.on("error", resolve);
      ws.write(Buffer.alloc(4));
      ws.write(Buffer.alloc(4));
    });
    expect(error.code).toBe("ENOSPC");
    // Both chunks were buffered while the stream opened and are written as one batch, atomically.
    expect(fs.statSync("/s").size).toBe(0);
  });

  it("counts unlinked-but-open files until closed", () => {
    const fs = createFs({ maxMemory: 20 });
    fs.writeFileSync("/f", Buffer.alloc(15));
    const fd = fs.openSync("/f", "r+");
    fs.unlinkSync("/f");
    expect(fs.getStats().usedMemory).toBe(15);
    expect(() => fs.writeFileSync("/g", Buffer.alloc(10))).toThrow(expect.objectContaining({ code: "ENOSPC" }));
    fs.closeSync(fd);
    expect(fs.getStats().usedMemory).toBe(0);
    fs.writeFileSync("/g", Buffer.alloc(10));
  });

  it("enforces maxNodes", () => {
    const fs = createFs({ maxNodes: 3 });
    fs.writeFileSync("/a", "");
    fs.mkdirSync("/b");
    expect(() => fs.writeFileSync("/c", "")).toThrow(expect.objectContaining({ code: "ENOSPC" }));
    expect(() => fs.mkdirSync("/b/c")).toThrow(expect.objectContaining({ code: "ENOSPC" }));
  });

  it("validates limit options", () => {
    expect(() => createFs({ maxMemory: -1 })).toThrow(RangeError);
    expect(() => createFs({ maxNodes: 0 })).toThrow(RangeError);
  });
});

describe("TTL", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("expires files and hides them immediately on access", () => {
    vi.useFakeTimers();
    const fs = createFs({ ttlCleanup: "lazy" });
    fs.writeFileSync("/cache.json", "{}", { ttl: 1000 });
    expect(fs.getTtl("/cache.json")).toBe(1000);
    vi.advanceTimersByTime(999);
    expect(fs.existsSync("/cache.json")).toBe(true);
    vi.advanceTimersByTime(1);
    expect(fs.getStats().fileCount).toBe(1); // lazy: not yet reclaimed
    expect(fs.existsSync("/cache.json")).toBe(false);
    expect(fs.getStats().fileCount).toBe(0);
  });

  it("timer strategy reclaims memory without access, and timers are unref'd", () => {
    vi.useFakeTimers();
    const fs = createFs();
    fs.mkdirSync("/tmp/session", { recursive: true, ttl: 500 });
    fs.writeFileSync("/tmp/session/data", Buffer.alloc(100));
    fs.writeFileSync("/later", "x", { ttl: 2000 });
    expect(fs.getStats().usedMemory).toBe(101);
    vi.advanceTimersByTime(500);
    expect(fs.getStats().usedMemory).toBe(1);
    expect(fs.readdirSync("/tmp")).toEqual([]);
    vi.advanceTimersByTime(1500);
    expect(fs.getStats().usedMemory).toBe(0);
  });

  it("does not keep the event loop alive", () => {
    const fs = createFs();
    const spy = vi.spyOn(globalThis, "setTimeout");
    fs.writeFileSync("/x", "x", { ttl: 60_000 });
    const timer = spy.mock.results.at(-1)?.value as NodeJS.Timeout;
    expect(timer.hasRef()).toBe(false);
    spy.mockRestore();
    fs.dispose();
  });

  it("setTtl, clearing, purgeExpired and rewriting", () => {
    vi.useFakeTimers();
    const fs = createFs({ ttlCleanup: "lazy" });
    fs.writeFileSync("/a", "a");
    fs.setTtl("/a", 100);
    fs.writeFileSync("/b", "b", { ttl: 100 });
    fs.setTtl("/b", null);
    fs.writeFileSync("/c", "c", { ttl: 100 });
    fs.writeFileSync("/c", "c2"); // a write without ttl keeps the existing TTL
    vi.advanceTimersByTime(100);
    expect(fs.purgeExpired()).toBe(2);
    expect(fs.readdirSync("/")).toEqual(["b"]);
    expect(() => fs.setTtl("/", 10)).toThrow(expect.objectContaining({ code: "EBUSY" }));
    expect(() => fs.writeFileSync("/d", "d", { ttl: -1 })).toThrow(RangeError);
  });

  it("TTL follows renames", () => {
    vi.useFakeTimers();
    const fs = createFs();
    fs.writeFileSync("/a", "a", { ttl: 100 });
    fs.renameSync("/a", "/b");
    vi.advanceTimersByTime(100);
    expect(fs.existsSync("/b")).toBe(false);
  });
});

describe("isolation", () => {
  it("instances share nothing", () => {
    const a = createFs({ maxMemory: 10 });
    const b = createFs({ maxMemory: 1000 });
    a.writeFileSync("/data.txt", "A");
    b.writeFileSync("/data.txt", "B");
    expect(a.readFileSync("/data.txt", "utf-8")).toBe("A");
    expect(b.readFileSync("/data.txt", "utf-8")).toBe("B");
    b.writeFileSync("/big", Buffer.alloc(500));
    expect(() => a.writeFileSync("/big", Buffer.alloc(500))).toThrow(expect.objectContaining({ code: "ENOSPC" }));
  });

  it("descriptors from one instance are invalid in another", () => {
    const a = createFs();
    const b = createFs();
    a.writeFileSync("/f", "a");
    b.writeFileSync("/f", "b");
    const fd = a.openSync("/f", "r");
    expect(() => b.readSync(fd, Buffer.alloc(1))).toThrow(expect.objectContaining({ code: "EBADF" }));
    expect(() => b.closeSync(fd)).toThrow(expect.objectContaining({ code: "EBADF" }));
    a.closeSync(fd);
  });

  it("disposing one instance leaves others untouched", () => {
    const a = createFs();
    const b = createFs();
    a.writeFileSync("/f", "a");
    b.writeFileSync("/f", "b");
    a.dispose();
    expect(b.readFileSync("/f", "utf8")).toBe("b");
  });

  it("watchers only see their own instance", async () => {
    const a = createFs();
    const b = createFs();
    a.mkdirSync("/w");
    b.mkdirSync("/w");
    const seen: string[] = [];
    a.watch("/w", (_type, name) => seen.push(String(name)));
    b.writeFileSync("/w/b", "b");
    a.writeFileSync("/w/a", "a");
    await new Promise((r) => setImmediate(r));
    expect(seen.every((n) => n === "a")).toBe(true);
    expect(seen.length).toBeGreaterThan(0);
  });
});

describe("lifecycle", () => {
  it("dispose releases data, descriptors, watchers and timers", async () => {
    const fs = createFs();
    fs.writeFileSync("/f", Buffer.alloc(1000), { ttl: 60_000 });
    fs.openSync("/f", "r");
    const watcher = fs.watch("/");
    const closed = new Promise((r) => watcher.on("close", r));
    fs.dispose();
    await closed;
    expect(fs.isDisposed).toBe(true);
    expect(fs.getStats()).toMatchObject({ usedMemory: 0, fileCount: 0, openFileDescriptors: 0, watcherCount: 0, disposed: true });
    expect(() => fs.readFileSync("/f")).toThrow(expect.objectContaining({ code: "ERR_MEMSPACE_DISPOSED" }));
    await expect(Promise.resolve().then(() => fs.promises)).rejects.toMatchObject({ code: "ERR_MEMSPACE_DISPOSED" });
    fs.dispose(); // idempotent
  });

  it("supports `using` via Symbol.dispose", () => {
    const fs = createFs();
    fs[Symbol.dispose]();
    expect(fs.isDisposed).toBe(true);
  });

  it("reset empties the filesystem but keeps it usable", () => {
    const fs = createFs();
    fs.mkdirSync("/a/b", { recursive: true });
    const fd = fs.openSync("/a/x", "w");
    fs.reset();
    expect(fs.readdirSync("/")).toEqual([]);
    expect(() => fs.closeSync(fd)).toThrow(expect.objectContaining({ code: "EBADF" }));
    expect(fs.getStats()).toMatchObject({ nodeCount: 1, usedMemory: 0 });
    fs.writeFileSync("/again", "ok");
  });
});
