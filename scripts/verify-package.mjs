#!/usr/bin/env node
/**
 * Pack the package, install the tarball into a throwaway consumer project and
 * verify ESM, CommonJS, subpath exports and TypeScript type resolution, exactly
 * as an external user would see them. Run after `npm run build`.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const work = mkdtempSync(join(tmpdir(), "memspace-verify-"));
const run = (cmd, args, cwd = work) => execFileSync(cmd, args, { cwd, stdio: ["ignore", "pipe", "inherit"], encoding: "utf8" });

try {
  const tarball = run("npm", ["pack", "--silent", "--pack-destination", work], root).trim().split("\n").pop();
  writeFileSync(join(work, "package.json"), JSON.stringify({ name: "consumer", private: true, type: "module" }));
  run("npm", ["install", "--silent", "--no-audit", "--no-fund", join(work, tarball), `typescript@${JSON.parse(run("node", ["-p", "JSON.stringify(require('typescript/package.json').version)"], root))}`, "@types/node", "@types/express"]);

  writeFileSync(join(work, "esm.mjs"), `
    import fs, { createFs, VirtualFileSystem, readFileSync, writeFileSync } from "memspace-fs";
    import { expressMiddleware, serveStatic } from "memspace-fs/express";
    import { createFixture, toTree } from "memspace-fs/testing";
    writeFileSync("/a", "esm");
    if (readFileSync("/a", "utf8") !== "esm" || !(fs instanceof VirtualFileSystem)) throw new Error("esm default");
    const inst = createFs({ maxMemory: 10 });
    try { inst.writeFileSync("/x", "12345678901"); throw new Error("no limit"); } catch (e) { if (e.code !== "ENOSPC") throw e; }
    if (typeof expressMiddleware !== "function" || typeof serveStatic !== "function") throw new Error("express subpath");
    if (toTree(createFixture({ "/f": "1" })).f !== "1") throw new Error("testing subpath");
    console.log("esm ok");
  `);
  writeFileSync(join(work, "cjs.cjs"), `
    const memspace = require("memspace-fs");
    const { createFs, default: fs } = memspace;
    const { expressMiddleware } = require("memspace-fs/express");
    const { withFs } = require("memspace-fs/testing");
    fs.writeFileSync("/a", "cjs");
    if (memspace.readFileSync("/a", "utf8") !== "cjs") throw new Error("cjs default");
    if (createFs().existsSync("/a")) throw new Error("isolation");
    if (typeof expressMiddleware !== "function" || typeof withFs !== "function") throw new Error("cjs subpaths");
    console.log("cjs ok");
  `);
  writeFileSync(join(work, "types.mts"), `
    import fs, { createFs, type MemspaceStats, type Stats } from "memspace-fs";
    import { expressMiddleware } from "memspace-fs/express";
    import express from "express";
    const s: string = fs.readFileSync("/a", "utf8");
    const b: Buffer = fs.readFileSync("/a");
    const p: Promise<string> = createFs().promises.readFile("/a", "utf-8");
    const st: Stats = fs.statSync("/a");
    const m: MemspaceStats = fs.getStats();
    const app = express();
    app.use(expressMiddleware(fs, { attachToRequest: true }));
    app.get("/", (req, res) => { req.memspace?.existsSync("/"); res.locals.memspace?.readdirSync("/"); res.end(); });
    void [s, b, p, st, m];
  `);
  writeFileSync(join(work, "types.cts"), `
    import memspace = require("memspace-fs");
    const text: string = memspace.default.readFileSync("/a", "utf8");
    const inst = memspace.createFs();
    void [text, inst.getStats().usedMemory];
  `);
  run("npm", ["install", "--silent", "--no-audit", "--no-fund", "express"]);
  console.log(run("node", ["esm.mjs"]).trim());
  console.log(run("node", ["cjs.cjs"]).trim());
  for (const resolution of ["NodeNext", "Bundler"]) {
    const module = resolution === "Bundler" ? "ESNext" : "NodeNext";
    const files = resolution === "Bundler" ? ["types.mts"] : ["types.mts", "types.cts"];
    run("npx", ["tsc", "--noEmit", "--strict", "--skipLibCheck", "false", "--target", "ES2022", "--types", "node", "--module", module, "--moduleResolution", resolution, ...files]);
    console.log(`types ok (${resolution})`);
  }
  const packed = JSON.parse(run("npm", ["pack", "--dry-run", "--json"], root));
  const files = packed[0].files.map((f) => f.path);
  const unexpected = files.filter((f) => !/^(dist\/|docs\/|README\.md|LICENSE|CHANGELOG\.md|package\.json)/.test(f));
  if (unexpected.length) throw new Error(`unexpected files in package: ${unexpected.join(", ")}`);
  console.log(`package contents ok (${files.length} files, ${(packed[0].size / 1024).toFixed(1)} KiB packed)`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
