import { describe, expect, it } from "vitest";
import { createFixture, populate, toTree, withFs, createFs } from "../../src/adapters/testing.js";

describe("testing utilities", () => {
  it("createFixture + toTree round-trip", () => {
    const fs = createFixture({
      "/app/config.json": '{"port":3000}',
      "/app/logo.bin": new Uint8Array([1, 2]),
      "/app/empty": null,
      "/app/current": { symlink: "/app/config.json" },
    });
    expect(toTree(fs, "/app")).toEqual({
      "config.json": '{"port":3000}',
      "logo.bin": "\u0001\u0002",
      empty: null,
      current: { symlink: "/app/config.json" },
    });
    expect(toTree(fs, "/app", { binary: true })["logo.bin"]).toEqual(Buffer.from([1, 2]));
  });

  it("populate resolves relative fixture paths against a root", () => {
    const fs = populate(createFs(), { "a/b.txt": "b" }, "/base");
    expect(fs.readFileSync("/base/a/b.txt", "utf8")).toBe("b");
  });

  it("withFs disposes even on failure", async () => {
    let captured: ReturnType<typeof createFs> | undefined;
    await expect(
      withFs((fs) => {
        captured = fs;
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(captured?.isDisposed).toBe(true);
    expect(await withFs((fs) => fs.readFileSync("/x", "utf8"), { "/x": "fixture" })).toBe("fixture");
  });

  it("replaces a real filesystem dependency in application code", async () => {
    // Application code written against the fs interface, injected with Memspace in tests.
    type FsLike = Pick<typeof import("node:fs"), "readFileSync" | "writeFileSync" | "existsSync">;
    const loadConfig = (fsImpl: FsLike, path: string) =>
      fsImpl.existsSync(path) ? JSON.parse(fsImpl.readFileSync(path, "utf8") as string) : { port: 80 };
    const fs = createFixture({ "/etc/app.json": '{"port":8080}' });
    expect(loadConfig(fs as unknown as FsLike, "/etc/app.json")).toEqual({ port: 8080 });
    expect(loadConfig(fs as unknown as FsLike, "/missing.json")).toEqual({ port: 80 });
  });
});
