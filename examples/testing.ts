/**
 * Testing: inject Memspace into code that takes an fs-like dependency.
 * Run: npx vitest run examples/testing.ts  (or adapt into your own test suite)
 */
import { describe, expect, it } from "vitest";
import { createFixture, toTree } from "memspace-fs/testing";
import type { VirtualFileSystem } from "memspace-fs";

// Application code: depends on an fs-shaped object rather than importing node:fs.
function bumpVersion(fs: Pick<VirtualFileSystem, "readFileSync" | "writeFileSync">, file: string): string {
  const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
  const [major, minor, patch] = pkg.version.split(".").map(Number);
  pkg.version = `${major}.${minor}.${patch + 1}`;
  fs.writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
  return pkg.version;
}

describe("bumpVersion", () => {
  it("increments the patch version", () => {
    const fs = createFixture({ "/repo/package.json": '{"name":"x","version":"1.2.3"}' });
    expect(bumpVersion(fs, "/repo/package.json")).toBe("1.2.4");
    expect(toTree(fs, "/repo")).toEqual({ "package.json": '{\n  "name": "x",\n  "version": "1.2.4"\n}\n' });
    fs.dispose();
  });
});
