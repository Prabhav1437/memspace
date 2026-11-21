import { describe, expect, it } from "vitest";
import defaultFs, { createFs, readFileSync, writeFileSync, VirtualFileSystem, isErrnoException } from "../../src/index.js";

describe("files", () => {
  it("creates, reads, overwrites, appends and deletes", () => {
    const fs = createFs();
    fs.writeFileSync("/f.txt", "one");
    fs.writeFileSync("/f.txt", "two");
    fs.appendFileSync("/f.txt", "+three");
    expect(fs.readFileSync("/f.txt", "utf-8")).toBe("two+three");
    fs.unlinkSync("/f.txt");
    expect(fs.existsSync("/f.txt")).toBe(false);
  });

  it("returns copies, never views of internal storage", () => {
    const fs = createFs();
    const input = Buffer.from("abc");
    fs.writeFileSync("/f", input);
    input[0] = 0x7a;
    const out = fs.readFileSync("/f");
    out[1] = 0x7a;
    expect(fs.readFileSync("/f", "utf8")).toBe("abc");
  });

  it("handles large binary content", () => {
    const fs = createFs();
    const data = Buffer.alloc(8 * 1024 * 1024);
    for (let i = 0; i < data.length; i += 4096) data[i] = i % 251;
    fs.writeFileSync("/big.bin", data);
    expect(fs.readFileSync("/big.bin").equals(data)).toBe(true);
    expect(fs.statSync("/big.bin").size).toBe(data.length);
  });

  it("supports DataView and typed arrays of any element size", () => {
    const fs = createFs();
    fs.writeFileSync("/dv", new DataView(new Uint8Array([1, 2]).buffer));
    fs.writeFileSync("/u16", new Uint16Array([0x0102]));
    expect([...fs.readFileSync("/dv")]).toEqual([1, 2]);
    expect(fs.readFileSync("/u16").byteLength).toBe(2);
  });

  it("updates timestamps", async () => {
    const fs = createFs();
    fs.writeFileSync("/t", "a");
    const first = fs.statSync("/t");
    await new Promise((r) => setTimeout(r, 5));
    fs.appendFileSync("/t", "b");
    const second = fs.statSync("/t");
    expect(second.mtimeMs).toBeGreaterThan(first.mtimeMs);
    expect(second.birthtimeMs).toBe(first.birthtimeMs);
    expect(second.mtime).toBeInstanceOf(Date);
  });

  it("copyFile rejects COPYFILE_FICLONE_FORCE honestly", () => {
    const fs = createFs();
    fs.writeFileSync("/a", "x");
    expect(() => fs.copyFileSync("/a", "/b", fs.constants.COPYFILE_FICLONE_FORCE)).toThrow(expect.objectContaining({ code: "ENOTSUP" }));
    fs.copyFileSync("/a", "/b", fs.constants.COPYFILE_FICLONE);
    expect(fs.readFileSync("/b", "utf8")).toBe("x");
  });
});

describe("error objects", () => {
  it("carry code, errno, syscall, path and a Node-style message", () => {
    const fs = createFs();
    try {
      fs.readFileSync("/missing.txt");
      expect.unreachable();
    } catch (error) {
      expect(isErrnoException(error)).toBe(true);
      expect(error).toBeInstanceOf(Error);
      expect(error).toMatchObject({ code: "ENOENT", syscall: "open", path: "/missing.txt", errno: expect.any(Number) });
      expect((error as Error).message).toBe("ENOENT: no such file or directory, open '/missing.txt'");
    }
  });

  it("includes dest for two-path operations", () => {
    const fs = createFs();
    expect(() => fs.renameSync("/a", "/b")).toThrow(expect.objectContaining({ path: "/a", dest: "/b", syscall: "rename" }));
  });
});

describe("module surface", () => {
  it("default instance is isolated from created instances", () => {
    const other = createFs();
    defaultFs.writeFileSync("/only-default", "d");
    expect(other.existsSync("/only-default")).toBe(false);
    expect(defaultFs).toBeInstanceOf(VirtualFileSystem);
    defaultFs.unlinkSync("/only-default");
  });

  it("named exports are bound to the default instance", () => {
    writeFileSync("/named.txt", "named");
    expect(readFileSync("/named.txt", "utf8")).toBe("named");
    expect(defaultFs.existsSync("/named.txt")).toBe(true);
    defaultFs.rmSync("/named.txt");
  });

  it("methods survive destructuring", () => {
    const { writeFileSync: w, readFileSync: r, promises } = createFs();
    w("/d", "ok");
    expect(r("/d", "utf8")).toBe("ok");
    expect(typeof promises.readFile).toBe("function");
  });

  it("exposes fs-like classes and constants", () => {
    const fs = createFs();
    expect(fs.constants.O_CREAT).toBeTypeOf("number");
    expect(fs.statSync("/")).toBeInstanceOf(fs.Stats);
    expect(fs.F_OK).toBe(0);
  });
});
