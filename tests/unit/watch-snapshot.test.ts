import { describe, expect, it } from "vitest";
import { createFs } from "../../src/index.js";

const tick = () => new Promise((r) => setImmediate(r));

describe("watchers", () => {
  it("reports changes and renames for a directory's children", async () => {
    const fs = createFs();
    fs.mkdirSync("/w");
    const events: string[] = [];
    const watcher = fs.watch("/w", (type, name) => events.push(`${type}:${name}`));
    fs.writeFileSync("/w/a", "1");
    fs.appendFileSync("/w/a", "2");
    fs.renameSync("/w/a", "/w/b");
    fs.mkdirSync("/w/sub");
    fs.writeFileSync("/w/sub/deep", "ignored without recursive");
    await tick();
    watcher.close();
    expect(events).toEqual(["rename:a", "change:a", "change:a", "rename:a", "rename:b", "rename:sub"]);
  });

  it("supports recursive watching and file watching", async () => {
    const fs = createFs();
    fs.mkdirSync("/w/x", { recursive: true });
    fs.writeFileSync("/file", "");
    const deep: string[] = [];
    const single: string[] = [];
    const a = fs.watch("/w", { recursive: true }, (_t, name) => deep.push(String(name)));
    const b = fs.watch("/file", (t, name) => single.push(`${t}:${name}`));
    fs.writeFileSync("/w/x/y", "1");
    fs.writeFileSync("/file", "changed");
    fs.unlinkSync("/file");
    await tick();
    a.close();
    b.close();
    expect(deep).toContain("x/y");
    expect(single).toEqual(["change:file", "rename:file"]);
  });

  it("stops delivering after close and supports AbortSignal", async () => {
    const fs = createFs();
    const controller = new AbortController();
    const events: string[] = [];
    const watcher = fs.watch("/", { signal: controller.signal }, (_t, n) => events.push(String(n)));
    const closed = new Promise((r) => watcher.on("close", r));
    controller.abort();
    await closed;
    fs.writeFileSync("/x", "1");
    await tick();
    expect(events).toEqual([]);
    expect(fs.getStats().watcherCount).toBe(0);
  });

  it("fs.promises.watch yields events", async () => {
    const fs = createFs();
    const controller = new AbortController();
    const iterator = fs.promises.watch("/", { signal: controller.signal });
    setImmediate(() => fs.writeFileSync("/new", "x"));
    const { value } = await iterator.next();
    expect(value).toEqual({ eventType: "rename", filename: "new" });
    controller.abort();
    await expect(iterator.next()).rejects.toMatchObject({ name: "AbortError" });
  });

  it("watchFile reports stat changes event-driven", async () => {
    const fs = createFs();
    fs.writeFileSync("/f", "a");
    const sizes: Array<[number, number]> = [];
    fs.watchFile("/f", (curr, prev) => sizes.push([Number(curr.size), Number(prev.size)]));
    fs.writeFileSync("/f", "abc");
    await tick();
    fs.unlinkSync("/f");
    await tick();
    fs.unwatchFile("/f");
    fs.writeFileSync("/f", "after unwatch");
    await tick();
    expect(sizes).toEqual([[3, 1], [0, 3]]);
    expect(fs.getStats().watcherCount).toBe(0);
  });

  it("watching a missing path throws ENOENT", () => {
    const fs = createFs();
    expect(() => fs.watch("/missing")).toThrow(expect.objectContaining({ code: "ENOENT", syscall: "watch" }));
  });
});

describe("snapshots", () => {
  const populate = () => {
    const fs = createFs();
    fs.mkdirSync("/app/config", { recursive: true });
    fs.writeFileSync("/app/config/settings.json", '{"a":1}');
    fs.writeFileSync("/app/logo.bin", Buffer.from([0, 1, 2, 254, 255]));
    fs.writeFileSync("/app/empty", "");
    fs.symlinkSync("/app/config", "/current");
    fs.chmodSync("/app/logo.bin", 0o600);
    fs.utimesSync("/app/empty", 100, 200);
    return fs;
  };

  it("round-trips through JSON and binary representations", () => {
    const source = populate();
    for (const snapshot of [source.snapshot(), JSON.parse(JSON.stringify(source.snapshot())), source.snapshot({ format: "binary" }), JSON.stringify(source.snapshot())]) {
      const restored = createFs();
      restored.restore(snapshot);
      expect(restored.readFileSync("/app/config/settings.json", "utf8")).toBe('{"a":1}');
      expect([...restored.readFileSync("/app/logo.bin")]).toEqual([0, 1, 2, 254, 255]);
      expect(restored.statSync("/app/logo.bin").mode & 0o777).toBe(0o600);
      expect(restored.statSync("/app/empty").mtimeMs).toBe(200_000);
      expect(restored.readlinkSync("/current")).toBe("/app/config");
      expect(restored.readdirSync("/current")).toEqual(["settings.json"]);
      expect(restored.getStats()).toMatchObject({ fileCount: 3, directoryCount: 3, symlinkCount: 1, usedMemory: source.getStats().usedMemory });
    }
  });

  it("snapshots are independent of later changes", () => {
    const fs = populate();
    const snap = fs.snapshot();
    fs.writeFileSync("/app/config/settings.json", "changed");
    fs.restore(snap);
    expect(fs.readFileSync("/app/config/settings.json", "utf8")).toBe('{"a":1}');
  });

  it("restore replaces existing content and invalidates descriptors", () => {
    const fs = createFs();
    fs.writeFileSync("/old", "old");
    const fd = fs.openSync("/old", "r");
    fs.restore(populate().snapshot());
    expect(fs.existsSync("/old")).toBe(false);
    expect(() => fs.closeSync(fd)).toThrow(expect.objectContaining({ code: "EBADF" }));
  });

  it("rejects malformed snapshots without changing anything", () => {
    const fs = createFs();
    fs.writeFileSync("/keep", "me");
    const good = populate().snapshot();
    const bad: unknown[] = [
      null,
      "not json",
      { ...good, format: "other" },
      { ...good, version: 99 },
      { ...good, entries: [] },
      { ...good, entries: good.entries.slice(1) },
      { ...good, entries: [good.entries[0], { ...good.entries[1], path: "/x/../y" }] },
      { ...good, entries: [good.entries[0], { ...good.entries[2], path: "/nope/child" }] },
      { ...good, entries: [good.entries[0], good.entries[1], good.entries[1]] },
      { ...good, entries: [good.entries[0], { ...good.entries[1], type: "fifo" }] },
      { ...good, entries: [good.entries[0], { ...good.entries[1], mode: "rw" }] },
      { ...good, entries: good.entries.map((e) => (e.type === "file" ? { ...e, content: "!!!" } : e)) },
      Buffer.from("garbage"),
      Buffer.concat([good && createFs().snapshot({ format: "binary" }).subarray(0, 20)]),
    ];
    for (const snapshot of bad) {
      expect(() => fs.restore(snapshot as never)).toThrow(expect.objectContaining({ code: "ERR_MEMSPACE_INVALID_SNAPSHOT" }));
    }
    expect(fs.readFileSync("/keep", "utf8")).toBe("me");
  });

  it("respects the target's memory limits", () => {
    const big = createFs();
    big.writeFileSync("/f", Buffer.alloc(1000));
    const small = createFs({ maxMemory: 100 });
    small.writeFileSync("/keep", "x");
    expect(() => small.restore(big.snapshot())).toThrow(expect.objectContaining({ code: "ENOSPC" }));
    expect(small.existsSync("/keep")).toBe(true);
  });

  it("drops expired entries and keeps pending TTLs", () => {
    const fs = createFs();
    fs.writeFileSync("/ttl", "x", { ttl: 60_000 });
    const snap = fs.snapshot();
    expect(snap.entries.find((e) => e.path === "/ttl")?.expiresAt).toBeGreaterThan(Date.now());
    const restored = createFs();
    restored.restore(snap);
    expect(restored.getTtl("/ttl")).toBeGreaterThan(0);
    restored.restore({ ...snap, entries: snap.entries.map((e) => (e.path === "/ttl" ? { ...e, expiresAt: 1 } : e)) });
    expect(restored.existsSync("/ttl")).toBe(false);
    fs.dispose();
    restored.dispose();
  });
});
