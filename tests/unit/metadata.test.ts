import { describe, expect, it } from "vitest";
import { createFs } from "../../src/index.js";

describe("Stats and Dirent", () => {
  it("implement every type predicate", () => {
    const fs = createFs();
    fs.writeFileSync("/f", "abc");
    fs.symlinkSync("/f", "/l");
    const file = fs.statSync("/f");
    const link = fs.lstatSync("/l");
    expect([file.isFile(), file.isDirectory(), file.isSymbolicLink()]).toEqual([true, false, false]);
    expect([link.isFile(), link.isSymbolicLink(), link.size]).toEqual([false, true, 2]);
    for (const s of [file, link]) {
      expect([s.isBlockDevice(), s.isCharacterDevice(), s.isFIFO(), s.isSocket()]).toEqual([false, false, false, false]);
    }
    const [dirent] = fs.readdirSync("/", { withFileTypes: true });
    expect(dirent).toBeInstanceOf(fs.Dirent);
    expect(dirent!.isFIFO()).toBe(false);
  });

  it("bigint stats carry nanosecond fields", () => {
    const fs = createFs();
    fs.writeFileSync("/f", "abc");
    const s = fs.statSync("/f", { bigint: true });
    expect(s.size).toBe(3n);
    expect(typeof s.mtimeNs).toBe("bigint");
    expect(s.isFile()).toBe(true);
  });

  it("ino is unique and stable across renames", () => {
    const fs = createFs();
    fs.writeFileSync("/a", "1");
    fs.writeFileSync("/b", "2");
    const ino = fs.statSync("/a").ino;
    expect(fs.statSync("/b").ino).not.toBe(ino);
    fs.renameSync("/a", "/c");
    expect(fs.statSync("/c").ino).toBe(ino);
  });

  it("directory nlink counts subdirectories", () => {
    const fs = createFs();
    fs.mkdirSync("/d/a", { recursive: true });
    fs.mkdirSync("/d/b");
    fs.writeFileSync("/d/f", "");
    expect(fs.statSync("/d").nlink).toBe(4);
  });

  it("applies umask and stores chmod/chown", () => {
    const fs = createFs({ umask: 0o027 });
    fs.writeFileSync("/f", "x");
    fs.mkdirSync("/d");
    expect(fs.statSync("/f").mode & 0o777).toBe(0o640);
    expect(fs.statSync("/d").mode & 0o777).toBe(0o750);
    fs.chownSync("/f", 1234, 5678);
    expect(fs.statSync("/f")).toMatchObject({ uid: 1234, gid: 5678 });
    fs.chownSync("/f", -1, 1);
    expect(fs.statSync("/f")).toMatchObject({ uid: 1234, gid: 1 });
  });

  it("lchmod/lutimes/lchown act on the link itself", () => {
    const fs = createFs();
    fs.writeFileSync("/t", "x");
    fs.symlinkSync("/t", "/l");
    fs.lutimesSync("/l", 10, 20);
    expect(fs.lstatSync("/l").mtimeMs).toBe(20_000);
    expect(fs.statSync("/t").mtimeMs).not.toBe(20_000);
    fs.lchownSync("/l", 7, 7);
    expect(fs.lstatSync("/l").uid).toBe(7);
    expect(fs.statSync("/t").uid).not.toBe(7);
  });
});

describe("permissions", () => {
  it('"ignore" mode stores but does not enforce mode bits', () => {
    const fs = createFs();
    fs.writeFileSync("/f", "x");
    fs.chmodSync("/f", 0o000);
    expect(fs.readFileSync("/f", "utf8")).toBe("x");
    fs.accessSync("/f", fs.constants.R_OK | fs.constants.W_OK);
    expect(() => fs.accessSync("/f", fs.constants.X_OK)).toThrow(expect.objectContaining({ code: "EACCES" }));
  });

  it('"owner" mode enforces owner bits', () => {
    const fs = createFs({ permissions: "owner", uid: 1000, gid: 1000 });
    fs.writeFileSync("/f", "x");
    fs.chmodSync("/f", 0o444);
    expect(() => fs.writeFileSync("/f", "y")).toThrow(expect.objectContaining({ code: "EACCES", syscall: "open" }));
    expect(fs.readFileSync("/f", "utf8")).toBe("x");
    fs.chmodSync("/f", 0o222);
    expect(() => fs.readFileSync("/f")).toThrow(expect.objectContaining({ code: "EACCES" }));

    fs.mkdirSync("/locked");
    fs.writeFileSync("/locked/inner", "i");
    fs.chmodSync("/locked", 0o500);
    expect(() => fs.writeFileSync("/locked/new", "n")).toThrow(expect.objectContaining({ code: "EACCES" }));
    expect(() => fs.unlinkSync("/locked/inner")).toThrow(expect.objectContaining({ code: "EACCES" }));
    fs.chmodSync("/locked", 0o000);
    expect(() => fs.readFileSync("/locked/inner")).toThrow(expect.objectContaining({ code: "EACCES" }));
    expect(() => fs.accessSync("/locked", fs.constants.R_OK)).toThrow(expect.objectContaining({ code: "EACCES" }));
    fs.chmodSync("/locked", 0o700);
    expect(fs.readFileSync("/locked/inner", "utf8")).toBe("i");
  });

  it('"owner" mode uses group and other bits for other identities', () => {
    const fs = createFs({ permissions: "owner", uid: 1000, gid: 1000 });
    fs.writeFileSync("/f", "x");
    fs.chownSync("/f", 1, 1000);
    fs.chmodSync("/f", 0o040);
    expect(fs.readFileSync("/f", "utf8")).toBe("x");
    fs.chownSync("/f", 1, 1);
    expect(() => fs.readFileSync("/f")).toThrow(expect.objectContaining({ code: "EACCES" }));
  });
});
