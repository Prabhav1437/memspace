import { describe, expect, it } from "vitest";
import { createFs } from "../../src/index.js";
import { resolvePath, splitComponents } from "../../src/core/path.js";

describe("path normalization", () => {
  it("collapses ., .. and repeated slashes", () => {
    expect(resolvePath("/", "//a///b/./c/../d")).toBe("/a/b/d");
    expect(resolvePath("/", "/")).toBe("/");
    expect(splitComponents("/a/./b/../../..")).toEqual([]);
  });

  it("resolves relative paths against the instance cwd", () => {
    const fs = createFs({ cwd: "/work/dir" });
    fs.writeFileSync("file.txt", "rel");
    expect(fs.readFileSync("/work/dir/file.txt", "utf8")).toBe("rel");
    expect(fs.readFileSync("./file.txt", "utf8")).toBe("rel");
    expect(fs.readFileSync("../dir/file.txt", "utf8")).toBe("rel");
    fs.chdir("..");
    expect(fs.cwd()).toBe("/work");
    expect(fs.readdirSync(".")).toEqual(["dir"]);
  });

  it("never escapes the virtual root", () => {
    const fs = createFs();
    fs.mkdirSync("/../../etc");
    fs.writeFileSync("/../../../../etc/passwd", "virtual");
    expect(fs.readdirSync("/")).toEqual(["etc"]);
    expect(fs.readFileSync("/etc/../../etc/passwd", "utf8")).toBe("virtual");
    expect(fs.realpathSync("/../..")).toBe("/");
    fs.chdir("/etc");
    expect(fs.readFileSync("../../../etc/passwd", "utf8")).toBe("virtual");
  });

  it("symlinks with absolute or climbing targets stay inside the namespace", () => {
    const fs = createFs();
    fs.symlinkSync("/../../../", "/up");
    expect(fs.realpathSync("/up")).toBe("/");
    fs.symlinkSync("../../../../../", "/rel-up");
    expect(fs.realpathSync("/rel-up")).toBe("/");
  });

  it("accepts Buffer and file: URL paths", () => {
    const fs = createFs();
    fs.writeFileSync(Buffer.from("/buf.txt"), "b");
    expect(fs.readFileSync(new URL("file:///buf.txt"), "utf8")).toBe("b");
    expect(fs.existsSync(new URL("file:///b%75f.txt"))).toBe(true);
  });

  it("rejects invalid paths like Node", () => {
    const fs = createFs();
    expect(() => fs.readFileSync(new URL("http://example.com/x"))).toThrow(expect.objectContaining({ code: "ERR_INVALID_URL_SCHEME" }));
    expect(() => fs.readFileSync(42 as unknown as string)).toThrow(expect.objectContaining({ code: "EBADF" }));
    expect(() => fs.readFileSync({} as unknown as string)).toThrow(expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }));
    expect(() => fs.writeFileSync("/a\u0000b", "x")).toThrow(expect.objectContaining({ code: "ERR_INVALID_ARG_VALUE" }));
    expect(fs.existsSync("/a\u0000b")).toBe(false);
  });

  it("rejects over-long names", () => {
    const fs = createFs();
    expect(() => fs.writeFileSync(`/${"n".repeat(256)}`, "x")).toThrow(expect.objectContaining({ code: "ENAMETOOLONG" }));
    fs.writeFileSync(`/${"n".repeat(255)}`, "x");
  });
});
