import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { describe, expect, it } from "vitest";
import { createFs, FileHandle } from "../../src/index.js";

describe("callback API", () => {
  it("delivers results asynchronously and errors through the callback", async () => {
    const fs = createFs();
    const order: string[] = [];
    await new Promise<void>((resolve) => {
      fs.writeFile("/f", "data", (err) => {
        order.push(`write:${err}`);
        fs.readFile("/f", "utf8", (err2, content) => {
          order.push(`read:${content}`);
          resolve();
        });
      });
      order.push("sync");
    });
    expect(order).toEqual(["sync", "write:null", "read:data"]);
  });

  it("throws argument errors synchronously like Node", () => {
    const fs = createFs();
    expect(() => fs.readFile("/x", undefined as never)).toThrow(TypeError);
    expect(() => fs.open("/x", "bogus", () => {})).toThrow(expect.objectContaining({ code: "ERR_INVALID_ARG_VALUE" }));
  });

  it("read/write callbacks receive byte counts and buffers", async () => {
    const fs = createFs();
    const fd = fs.openSync("/f", "w+");
    const [written, data] = await new Promise<[number, unknown]>((res, rej) =>
      fs.write(fd, "hello", (err, n, str) => (err ? rej(err) : res([n, str]))),
    );
    expect([written, data]).toEqual([5, "hello"]);
    const buf = Buffer.alloc(5);
    const [read, same] = await new Promise<[number, unknown]>((res, rej) =>
      fs.read(fd, buf, 0, 5, 0, (err, n, b) => (err ? rej(err) : res([n, b]))),
    );
    expect(read).toBe(5);
    expect(same).toBe(buf);
    const fromOptions = await new Promise<number>((res, rej) => fs.read(fd, { position: 1 }, (err, n) => (err ? rej(err) : res(n))));
    expect(fromOptions).toBe(4);
    fs.closeSync(fd);
  });

  it("exists() passes a single boolean", async () => {
    const fs = createFs();
    expect(await new Promise((r) => fs.exists("/", r))).toBe(true);
    expect(await new Promise((r) => fs.exists("/nope", r))).toBe(false);
  });

  it("realpath.native exists on both forms", async () => {
    const fs = createFs();
    fs.mkdirSync("/real");
    fs.symlinkSync("/real", "/alias");
    expect(fs.realpathSync.native("/alias")).toBe("/real");
    expect(await new Promise((r) => fs.realpath.native("/alias", (_e: unknown, p: unknown) => r(p)))).toBe("/real");
  });
});

describe("promise API", () => {
  it("mirrors the sync API, including rejections for invalid args", async () => {
    const fs = createFs();
    const p = fs.promises;
    await p.mkdir("/uploads", { recursive: true });
    await p.writeFile("/uploads/file.txt", "Temporary content");
    expect(await p.readFile("/uploads/file.txt", "utf-8")).toBe("Temporary content");
    expect((await p.stat("/uploads")).isDirectory()).toBe(true);
    await p.rename("/uploads/file.txt", "/uploads/renamed.txt");
    expect(await p.readdir("/uploads")).toEqual(["renamed.txt"]);
    await p.copyFile("/uploads/renamed.txt", "/copy.txt");
    await p.unlink("/uploads/renamed.txt");
    await p.rm("/uploads", { recursive: true });
    expect(await p.readdir("/")).toEqual(["copy.txt"]);
    await expect(p.readFile({} as never)).rejects.toMatchObject({ code: "ERR_INVALID_ARG_TYPE" });
    await expect(p.access("/nope")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("writeFile accepts iterables and async iterables", async () => {
    const fs = createFs();
    await fs.promises.writeFile("/it", ["a", "b", Buffer.from("c")]);
    await fs.promises.writeFile("/ait", Readable.from(["x", "y"]));
    expect(fs.readFileSync("/it", "utf8")).toBe("abc");
    expect(fs.readFileSync("/ait", "utf8")).toBe("xy");
  });

  it("honours AbortSignal", async () => {
    const fs = createFs();
    const controller = new AbortController();
    controller.abort();
    await expect(fs.promises.writeFile("/f", "x", { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(fs.existsSync("/f")).toBe(false);
  });

  it("FileHandle supports the common surface", async () => {
    const fs = createFs();
    await using handle = await fs.promises.open("/h.txt", "w+");
    expect(handle).toBeInstanceOf(FileHandle);
    await handle.writeFile("line1\nline2\n");
    await handle.truncate(12);
    await handle.chmod(0o600);
    await handle.utimes(1, 2);
    await handle.sync();
    expect((await handle.stat()).size).toBe(12);
    const lines: string[] = [];
    const reader = await fs.promises.open("/h.txt");
    for await (const line of reader.readLines()) lines.push(line);
    await reader.close();
    expect(lines).toEqual(["line1", "line2"]);
    expect(await fs.promises.readFile("/h.txt", "utf8")).toBe("line1\nline2\n");
  });

  it("FileHandle rejects after close", async () => {
    const fs = createFs();
    const handle = await fs.promises.open("/f", "w");
    await handle.close();
    await handle.close();
    expect(handle.fd).toBe(-1);
    await expect(handle.write("x")).rejects.toMatchObject({ code: "EBADF" });
  });

  it("concurrent async operations are atomic", async () => {
    const fs = createFs();
    await Promise.all(Array.from({ length: 200 }, (_, i) => fs.promises.appendFile("/log", `${i}\n`)));
    const lines = (fs.readFileSync("/log", "utf8") as string).trim().split("\n");
    expect(lines).toHaveLength(200);
    expect(new Set(lines).size).toBe(200);
  });
});

describe("streams", () => {
  it("pipes between memspace files without touching disk", async () => {
    const fs = createFs();
    const data = Buffer.alloc(1024 * 1024, "z");
    fs.writeFileSync("/in", data);
    await pipeline(fs.createReadStream("/in", { highWaterMark: 1000 }), fs.createWriteStream("/out"));
    expect(fs.readFileSync("/out").equals(data)).toBe(true);
    expect(fs.getStats().openFileDescriptors).toBe(0);
  });

  it("emits open/ready/close and tracks bytes", async () => {
    const fs = createFs();
    fs.writeFileSync("/f", "0123456789");
    const events: string[] = [];
    const rs = fs.createReadStream("/f", { start: 3 });
    rs.on("open", () => events.push("open")).on("ready", () => events.push("ready"));
    for await (const _chunk of rs) { /* drain */ }
    expect(rs.bytesRead).toBe(7);
    expect(events).toEqual(["open", "ready"]);

    const ws = fs.createWriteStream("/g", { flags: "w" });
    ws.write("abc");
    await new Promise<void>((r) => ws.end(() => r()));
    expect(ws.bytesWritten).toBe(3);
  });

  it("applies backpressure", async () => {
    const fs = createFs();
    const ws = fs.createWriteStream("/bp", { highWaterMark: 4 });
    expect(ws.write("12345678")).toBe(false);
    await new Promise((r) => ws.once("drain", r));
    ws.end();

    fs.writeFileSync("/src", Buffer.alloc(64 * 1024));
    let reads = 0;
    const slow = new Writable({
      highWaterMark: 1,
      write(_chunk, _enc, cb) {
        reads++;
        setImmediate(cb);
      },
    });
    await pipeline(fs.createReadStream("/src", { highWaterMark: 1024 }), slow);
    expect(reads).toBe(64);
  });

  it("can be destroyed mid-read and releases the descriptor", async () => {
    const fs = createFs();
    fs.writeFileSync("/f", Buffer.alloc(1 << 20));
    const rs = fs.createReadStream("/f", { highWaterMark: 1024 });
    await new Promise<void>((resolve) => {
      rs.once("data", () => {
        rs.destroy();
        rs.on("close", () => resolve());
      });
    });
    expect(rs.destroyed).toBe(true);
    expect(fs.getStats().openFileDescriptors).toBe(0);
  });

  it("propagates errors (missing file, directory)", async () => {
    const fs = createFs();
    fs.mkdirSync("/dir");
    const a = await new Promise<NodeJS.ErrnoException>((r) => fs.createReadStream("/missing").on("error", r));
    const b = await new Promise<NodeJS.ErrnoException>((r) => fs.createReadStream("/dir").on("error", r).resume());
    const c = await new Promise<NodeJS.ErrnoException>((r) => fs.createWriteStream("/dir").on("error", r));
    expect([a.code, b.code, c.code]).toEqual(["ENOENT", "EISDIR", "EISDIR"]);
  });

  it("write streams support start, append flags, fds and ttl", async () => {
    const fs = createFs();
    fs.writeFileSync("/f", "XXXXXX");
    await new Promise<void>((r) => fs.createWriteStream("/f", { flags: "r+", start: 2 }).end("ab", () => r()));
    expect(fs.readFileSync("/f", "utf8")).toBe("XXabXX");
    await new Promise<void>((r) => fs.createWriteStream("/f", { flags: "a" }).end("!", () => r()));
    expect(fs.readFileSync("/f", "utf8")).toBe("XXabXX!");
    const fd = fs.openSync("/viafd", "w");
    await new Promise<void>((r) => fs.createWriteStream(null, { fd }).end("fd", () => r()));
    expect(fs.readFileSync("/viafd", "utf8")).toBe("fd");
    await new Promise<void>((r) => fs.createWriteStream("/temp", { ttl: 50_000 }).end("t", () => r()));
    expect(fs.getTtl("/temp")).toBeGreaterThan(0);
  });

  it("validates start/end", () => {
    const fs = createFs();
    expect(() => fs.createReadStream("/f", { start: 5, end: 2 })).toThrow(RangeError);
    expect(() => fs.createReadStream("/f", { start: -1 })).toThrow(RangeError);
  });

  it("decodes with an encoding", async () => {
    const fs = createFs();
    fs.writeFileSync("/f", "héllo wörld");
    let text = "";
    for await (const chunk of fs.createReadStream("/f", { encoding: "utf8", highWaterMark: 1 })) text += chunk;
    expect(text).toBe("héllo wörld");
  });
});

describe("directories via opendir", () => {
  it("iterates asynchronously and closes", async () => {
    const fs = createFs();
    fs.mkdirSync("/d/sub", { recursive: true });
    fs.writeFileSync("/d/a", "");
    const names: string[] = [];
    for await (const entry of await fs.promises.opendir("/d")) names.push(String(entry.name));
    expect(names).toEqual(["a", "sub"]);
    const dir = fs.opendirSync("/d", { recursive: true });
    expect((await dir.read())?.name).toBe("a");
    dir.closeSync();
    expect(() => dir.readSync()).toThrow(expect.objectContaining({ code: "ERR_DIR_CLOSED" }));
  });
});
