/**
 * Behavioural comparison against native node:fs.
 *
 * Every scenario runs twice — once against a fresh temporary directory on the
 * real disk, once against a fresh Memspace instance — and the observable
 * outcomes (return values, error codes, syscalls and messages, with the root
 * prefix normalized) must match. Known, documented platform divergences are
 * listed explicitly so they are measured rather than assumed.
 */
import * as nodeFs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createFs } from "../../src/index.js";

type FsLike = typeof nodeFs;
type Outcome = { ok: unknown } | { error: { code: unknown; syscall: unknown; message: string } };

interface Scenario {
  name: string;
  run(fs: FsLike, root: string): unknown | Promise<unknown>;
  /** Platforms where native behaviour intentionally differs from Memspace (Linux semantics). */
  diverges?: NodeJS.Platform[];
}

const tmpRoots: string[] = [];
afterAll(() => {
  for (const dir of tmpRoots) nodeFs.rmSync(dir, { recursive: true, force: true });
});

function normalize(value: unknown, root: string): unknown {
  if (typeof value === "string") return value.split(root).join("<root>");
  if (Buffer.isBuffer(value)) return { buffer: value.toString("hex") };
  if (Array.isArray(value)) return value.map((v) => normalize(v, root));
  return value;
}

async function outcome(fs: FsLike, root: string, scenario: Scenario): Promise<Outcome> {
  try {
    return { ok: normalize(await scenario.run(fs, root), root) };
  } catch (error) {
    const e = error as NodeJS.ErrnoException;
    return { error: { code: e.code, syscall: e.syscall, message: normalize(e.message, root) as string } };
  }
}

async function compare(scenario: Scenario): Promise<{ native: Outcome; memspace: Outcome }> {
  const nativeRoot = nodeFs.realpathSync(nodeFs.mkdtempSync(path.join(os.tmpdir(), "memspace-compat-")));
  tmpRoots.push(nativeRoot);
  const mem = createFs({ name: "compat" });
  mem.mkdirSync("/compat");
  try {
    return {
      native: await outcome(nodeFs, nativeRoot, scenario),
      memspace: await outcome(mem as unknown as FsLike, "/compat", scenario),
    };
  } finally {
    mem.dispose();
  }
}

const j = path.join;
const write = (fs: FsLike, file: string, data: string | Uint8Array = "x") => fs.writeFileSync(file, data);
const listSorted = (list: unknown[]) => [...list].map(String).sort();
const sizeOf = (fs: FsLike, file: string) => fs.statSync(file).size;

const scenarios: Scenario[] = [
  // ---- files
  { name: "readFile missing", run: (fs, r) => fs.readFileSync(j(r, "missing.txt")) },
  { name: "readFile directory", run: (fs, r) => fs.readFileSync(r) },
  { name: "write/read utf8", run: (fs, r) => (write(fs, j(r, "a.txt"), "héllo"), fs.readFileSync(j(r, "a.txt"), "utf8")) },
  { name: "write/read binary", run: (fs, r) => (write(fs, j(r, "b.bin"), Buffer.from([0, 255, 1, 128])), fs.readFileSync(j(r, "b.bin"))) },
  { name: "write Uint8Array", run: (fs, r) => (write(fs, j(r, "u"), new Uint8Array([1, 2, 3])), fs.readFileSync(j(r, "u"))) },
  { name: "write empty file", run: (fs, r) => (write(fs, j(r, "e"), ""), [fs.readFileSync(j(r, "e"), "utf8"), sizeOf(fs, j(r, "e"))]) },
  { name: "write latin1 / base64 / hex encodings", run: (fs, r) => {
    fs.writeFileSync(j(r, "l"), "aGk=", "base64");
    fs.writeFileSync(j(r, "h"), "ff00", { encoding: "hex" });
    return [fs.readFileSync(j(r, "l"), "latin1"), fs.readFileSync(j(r, "h"), "base64")];
  } },
  { name: "overwrite shrinks", run: (fs, r) => (write(fs, j(r, "o"), "long content"), write(fs, j(r, "o"), "short"), fs.readFileSync(j(r, "o"), "utf8")) },
  { name: "writeFile into missing dir", run: (fs, r) => write(fs, j(r, "nope", "a.txt")) },
  { name: "writeFile under a file", run: (fs, r) => (write(fs, j(r, "f")), write(fs, j(r, "f", "a.txt"))) },
  { name: "writeFile on a directory", run: (fs, r) => write(fs, r) },
  { name: "writeFile wx on existing", run: (fs, r) => (write(fs, j(r, "w")), fs.writeFileSync(j(r, "w"), "y", { flag: "wx" })) },
  { name: "writeFile r+ on missing", run: (fs, r) => fs.writeFileSync(j(r, "m"), "y", { flag: "r+" }) },
  { name: "writeFile r+ overwrites in place", run: (fs, r) => (write(fs, j(r, "p"), "abcdef"), fs.writeFileSync(j(r, "p"), "XY", { flag: "r+" }), fs.readFileSync(j(r, "p"), "utf8")) },
  { name: "appendFile creates and appends", run: (fs, r) => (fs.appendFileSync(j(r, "ap"), "a"), fs.appendFileSync(j(r, "ap"), "b"), fs.readFileSync(j(r, "ap"), "utf8")) },
  { name: "readFile with trailing slash on file", run: (fs, r) => (write(fs, j(r, "t")), fs.readFileSync(`${j(r, "t")}/`)) },
  { name: "writeFile new path with trailing slash", run: (fs, r) => fs.writeFileSync(`${j(r, "new")}/`, "x"), diverges: ["darwin"] },
  { name: "unlink file", run: (fs, r) => (write(fs, j(r, "u")), fs.unlinkSync(j(r, "u")), fs.existsSync(j(r, "u"))) },
  { name: "unlink missing", run: (fs, r) => fs.unlinkSync(j(r, "missing")) },
  { name: "unlink directory", run: (fs, r) => (fs.mkdirSync(j(r, "d")), fs.unlinkSync(j(r, "d"))), diverges: ["darwin"] },
  { name: "copyFile", run: (fs, r) => (write(fs, j(r, "s"), "copy"), fs.copyFileSync(j(r, "s"), j(r, "d")), fs.readFileSync(j(r, "d"), "utf8")) },
  { name: "copyFile EXCL on existing", run: (fs, r) => (write(fs, j(r, "s")), write(fs, j(r, "d")), fs.copyFileSync(j(r, "s"), j(r, "d"), fs.constants.COPYFILE_EXCL)) },
  { name: "copyFile missing source", run: (fs, r) => fs.copyFileSync(j(r, "s"), j(r, "d")) },
  { name: "truncate extend and shrink", run: (fs, r) => {
    write(fs, j(r, "t"), "abc");
    fs.truncateSync(j(r, "t"), 5);
    const grown = fs.readFileSync(j(r, "t"));
    fs.truncateSync(j(r, "t"), 1);
    return [grown, fs.readFileSync(j(r, "t"), "utf8")];
  } },
  { name: "truncate missing", run: (fs, r) => fs.truncateSync(j(r, "missing")) },

  // ---- rename
  { name: "rename file", run: (fs, r) => (write(fs, j(r, "a"), "1"), fs.renameSync(j(r, "a"), j(r, "b")), [fs.existsSync(j(r, "a")), fs.readFileSync(j(r, "b"), "utf8")]) },
  { name: "rename replaces file", run: (fs, r) => (write(fs, j(r, "a"), "1"), write(fs, j(r, "b"), "2"), fs.renameSync(j(r, "a"), j(r, "b")), fs.readFileSync(j(r, "b"), "utf8")) },
  { name: "rename file over dir", run: (fs, r) => (write(fs, j(r, "a")), fs.mkdirSync(j(r, "d")), fs.renameSync(j(r, "a"), j(r, "d"))) },
  { name: "rename dir over file", run: (fs, r) => (write(fs, j(r, "a")), fs.mkdirSync(j(r, "d")), fs.renameSync(j(r, "d"), j(r, "a"))) },
  { name: "rename dir over empty dir", run: (fs, r) => (fs.mkdirSync(j(r, "d")), write(fs, j(r, "d", "x")), fs.mkdirSync(j(r, "e")), fs.renameSync(j(r, "d"), j(r, "e")), fs.readdirSync(j(r, "e"))) },
  { name: "rename dir over non-empty dir", run: (fs, r) => (fs.mkdirSync(j(r, "d")), fs.mkdirSync(j(r, "e")), write(fs, j(r, "e", "x")), fs.renameSync(j(r, "d"), j(r, "e"))) },
  { name: "rename dir into own subdir", run: (fs, r) => (fs.mkdirSync(j(r, "d", "s"), { recursive: true }), fs.renameSync(j(r, "d"), j(r, "d", "s", "x"))) },
  { name: "rename missing", run: (fs, r) => fs.renameSync(j(r, "a"), j(r, "b")) },
  { name: "rename to same path", run: (fs, r) => (write(fs, j(r, "a"), "z"), fs.renameSync(j(r, "a"), j(r, "a")), fs.readFileSync(j(r, "a"), "utf8")) },
  { name: "rename file to trailing-slash dest", run: (fs, r) => (write(fs, j(r, "a")), fs.renameSync(j(r, "a"), `${j(r, "b")}/`)), diverges: ["darwin"] },

  // ---- directories
  { name: "mkdir existing", run: (fs, r) => fs.mkdirSync(r) },
  { name: "mkdir missing parent", run: (fs, r) => fs.mkdirSync(j(r, "a", "b")) },
  { name: "mkdir recursive returns first created", run: (fs, r) => fs.mkdirSync(j(r, "a", "b", "c"), { recursive: true }) },
  { name: "mkdir recursive on existing", run: (fs, r) => fs.mkdirSync(r, { recursive: true }) },
  { name: "mkdir recursive over file", run: (fs, r) => (write(fs, j(r, "f")), fs.mkdirSync(j(r, "f"), { recursive: true })) },
  { name: "mkdir recursive through file", run: (fs, r) => (write(fs, j(r, "f")), fs.mkdirSync(j(r, "f", "g"), { recursive: true })) },
  { name: "mkdir trailing slash", run: (fs, r) => (fs.mkdirSync(`${j(r, "d")}/`), fs.statSync(j(r, "d")).isDirectory()) },
  { name: "readdir sorted", run: (fs, r) => (["c", "a", "b"].forEach((n) => write(fs, j(r, n))), listSorted(fs.readdirSync(r))) },
  { name: "readdir on file", run: (fs, r) => (write(fs, j(r, "f")), fs.readdirSync(j(r, "f"))) },
  { name: "readdir missing", run: (fs, r) => fs.readdirSync(j(r, "missing")) },
  { name: "readdir withFileTypes", run: (fs, r) => {
    write(fs, j(r, "f"));
    fs.mkdirSync(j(r, "d"));
    fs.symlinkSync("f", j(r, "l"));
    return fs.readdirSync(r, { withFileTypes: true })
      .map((d) => `${d.name}:${d.isFile()}:${d.isDirectory()}:${d.isSymbolicLink()}:${d.parentPath}`)
      .sort();
  } },
  { name: "readdir recursive", run: (fs, r) => {
    fs.mkdirSync(j(r, "a", "b"), { recursive: true });
    write(fs, j(r, "a", "b", "c.txt"));
    write(fs, j(r, "top.txt"));
    return listSorted(fs.readdirSync(r, { recursive: true }));
  } },
  { name: "readdir buffer encoding", run: (fs, r) => (write(fs, j(r, "n")), fs.readdirSync(r, { encoding: "buffer" })) },
  { name: "rmdir non-empty", run: (fs, r) => (fs.mkdirSync(j(r, "d")), write(fs, j(r, "d", "x")), fs.rmdirSync(j(r, "d"))) },
  { name: "rmdir on file", run: (fs, r) => (write(fs, j(r, "f")), fs.rmdirSync(j(r, "f"))) },
  { name: "rmdir missing", run: (fs, r) => fs.rmdirSync(j(r, "missing")) },
  { name: "rmdir empty", run: (fs, r) => (fs.mkdirSync(j(r, "d")), fs.rmdirSync(j(r, "d")), fs.existsSync(j(r, "d"))) },
  { name: "rm file", run: (fs, r) => (write(fs, j(r, "f")), fs.rmSync(j(r, "f")), fs.existsSync(j(r, "f"))) },
  { name: "rm dir without recursive", run: (fs, r) => (fs.mkdirSync(j(r, "d")), fs.rmSync(j(r, "d"))) },
  { name: "rm recursive", run: (fs, r) => (fs.mkdirSync(j(r, "d", "e"), { recursive: true }), write(fs, j(r, "d", "e", "f")), fs.rmSync(j(r, "d"), { recursive: true }), fs.existsSync(j(r, "d"))) },
  { name: "rm missing", run: (fs, r) => fs.rmSync(j(r, "missing")) },
  { name: "rm missing with force", run: (fs, r) => fs.rmSync(j(r, "missing"), { force: true }) },
  { name: "mkdtemp", run: (fs, r) => {
    const dir = fs.mkdtempSync(j(r, "tmp-"));
    return [path.basename(dir).length, fs.statSync(dir).isDirectory(), fs.statSync(dir).mode & 0o777];
  } },
  { name: "opendir reads entries", run: (fs, r) => {
    write(fs, j(r, "a"));
    write(fs, j(r, "b"));
    const dir = fs.opendirSync(r);
    const names: string[] = [];
    for (let e = dir.readSync(); e; e = dir.readSync()) names.push(e.name);
    dir.closeSync();
    return names.sort();
  } },
  { name: "cpSync recursive", run: (fs, r) => {
    fs.mkdirSync(j(r, "src", "deep"), { recursive: true });
    write(fs, j(r, "src", "deep", "f.txt"), "deep");
    fs.cpSync(j(r, "src"), j(r, "dst"), { recursive: true });
    return [listSorted(fs.readdirSync(j(r, "dst"), { recursive: true })), fs.readFileSync(j(r, "dst", "deep", "f.txt"), "utf8")];
  } },
  { name: "cpSync directory without recursive", run: (fs, r) => (fs.mkdirSync(j(r, "src")), fs.cpSync(j(r, "src"), j(r, "dst"))) },

  // ---- metadata
  { name: "stat file", run: (fs, r) => {
    write(fs, j(r, "f"), "12345");
    const s = fs.statSync(j(r, "f"));
    return [s.isFile(), s.isDirectory(), s.isSymbolicLink(), s.size, s.blocks > 0, typeof s.ino, s.nlink];
  } },
  { name: "stat directory", run: (fs, r) => [fs.statSync(r).isDirectory(), fs.statSync(r).isFile()] },
  { name: "stat missing", run: (fs, r) => fs.statSync(j(r, "missing")) },
  { name: "stat throwIfNoEntry false", run: (fs, r) => fs.statSync(j(r, "missing"), { throwIfNoEntry: false }) },
  { name: "stat bigint", run: (fs, r) => (write(fs, j(r, "f"), "abc"), typeof fs.statSync(j(r, "f"), { bigint: true }).size) },
  { name: "lstat missing", run: (fs, r) => fs.lstatSync(j(r, "missing")) },
  { name: "existsSync", run: (fs, r) => (write(fs, j(r, "f")), [fs.existsSync(j(r, "f")), fs.existsSync(j(r, "nope")), fs.existsSync(j(r, "f", "x"))]) },
  { name: "access missing", run: (fs, r) => fs.accessSync(j(r, "missing")) },
  { name: "access existing", run: (fs, r) => (write(fs, j(r, "f")), fs.accessSync(j(r, "f"), fs.constants.R_OK | fs.constants.W_OK)) },
  { name: "chmod", run: (fs, r) => (write(fs, j(r, "f")), fs.chmodSync(j(r, "f"), 0o640), fs.statSync(j(r, "f")).mode & 0o777) },
  { name: "chmod octal string", run: (fs, r) => (write(fs, j(r, "f")), fs.chmodSync(j(r, "f"), "755"), fs.statSync(j(r, "f")).mode & 0o777) },
  { name: "utimes", run: (fs, r) => {
    write(fs, j(r, "f"));
    fs.utimesSync(j(r, "f"), 1_000_000, new Date(2_000_000_000));
    const s = fs.statSync(j(r, "f"));
    return [s.atimeMs, s.mtimeMs];
  } },
  { name: "timestamps advance on write", run: async (fs, r) => {
    write(fs, j(r, "f"));
    const before = fs.statSync(j(r, "f")).mtimeMs;
    await new Promise((res) => setTimeout(res, 20));
    write(fs, j(r, "f"), "changed");
    return fs.statSync(j(r, "f")).mtimeMs > before;
  } },

  // ---- symlinks
  { name: "symlink stat vs lstat", run: (fs, r) => {
    write(fs, j(r, "target"), "t");
    fs.symlinkSync("target", j(r, "link"));
    return [fs.lstatSync(j(r, "link")).isSymbolicLink(), fs.statSync(j(r, "link")).isFile(), fs.readlinkSync(j(r, "link")), fs.readFileSync(j(r, "link"), "utf8")];
  } },
  { name: "symlink EEXIST", run: (fs, r) => (write(fs, j(r, "f")), fs.symlinkSync("x", j(r, "f"))) },
  { name: "readlink on file", run: (fs, r) => (write(fs, j(r, "f")), fs.readlinkSync(j(r, "f"))) },
  { name: "symlink loop", run: (fs, r) => (fs.symlinkSync("b", j(r, "a")), fs.symlinkSync("a", j(r, "b")), fs.readFileSync(j(r, "a"))) },
  { name: "dangling symlink", run: (fs, r) => (fs.symlinkSync("nowhere", j(r, "l")), [fs.lstatSync(j(r, "l")).isSymbolicLink(), fs.existsSync(j(r, "l"))]) },
  { name: "write through dangling symlink creates target", run: (fs, r) => (fs.symlinkSync("created", j(r, "l")), write(fs, j(r, "l"), "via link"), fs.readFileSync(j(r, "created"), "utf8")) },
  { name: "realpath through symlinked dir", run: (fs, r) => {
    fs.mkdirSync(j(r, "real", "inner"), { recursive: true });
    fs.symlinkSync(j(r, "real"), j(r, "alias"));
    return fs.realpathSync(j(r, "alias", "inner"));
  } },
  { name: "dot-dot after symlink is physical", run: (fs, r) => {
    fs.mkdirSync(j(r, "a", "b"), { recursive: true });
    write(fs, j(r, "a", "x"), "physical");
    fs.symlinkSync(j(r, "a", "b"), j(r, "l"));
    return fs.readFileSync(`${j(r, "l")}/../x`, "utf8");
  } },
  { name: "unlink symlink keeps target", run: (fs, r) => (write(fs, j(r, "t")), fs.symlinkSync("t", j(r, "l")), fs.unlinkSync(j(r, "l")), fs.existsSync(j(r, "t"))) },
  { name: "rm on symlink to dir removes link only", run: (fs, r) => (fs.mkdirSync(j(r, "d")), write(fs, j(r, "d", "x")), fs.symlinkSync("d", j(r, "l")), fs.rmSync(j(r, "l"), { recursive: true }), fs.readdirSync(j(r, "d"))) },

  // ---- descriptors
  { name: "open missing", run: (fs, r) => fs.openSync(j(r, "missing"), "r") },
  { name: "open wx existing", run: (fs, r) => (write(fs, j(r, "f")), fs.openSync(j(r, "f"), "wx")) },
  { name: "fd positional read/write", run: (fs, r) => {
    const fd = fs.openSync(j(r, "f"), "w+");
    fs.writeSync(fd, "hello world");
    fs.writeSync(fd, "W", 6);
    const buf = Buffer.alloc(5);
    const n = fs.readSync(fd, buf, 0, 5, 6);
    const pos = fs.readSync(fd, Buffer.alloc(10), 0, 10, null);
    fs.closeSync(fd);
    return [n, buf.toString(), pos, fs.readFileSync(j(r, "f"), "utf8")];
  } },
  { name: "sequential reads advance position", run: (fs, r) => {
    write(fs, j(r, "f"), "abcdef");
    const fd = fs.openSync(j(r, "f"), "r");
    const a = Buffer.alloc(2);
    const b = Buffer.alloc(10);
    fs.readSync(fd, a);
    const n = fs.readSync(fd, b);
    fs.closeSync(fd);
    return [a.toString(), n, b.subarray(0, n).toString()];
  } },
  { name: "readFileSync(fd) reads from position", run: (fs, r) => {
    write(fs, j(r, "f"), "abcdef");
    const fd = fs.openSync(j(r, "f"), "r");
    fs.readSync(fd, Buffer.alloc(2));
    const rest = fs.readFileSync(fd, "utf8");
    fs.closeSync(fd);
    return rest;
  } },
  { name: "write past end zero-fills", run: (fs, r) => {
    const fd = fs.openSync(j(r, "f"), "w");
    fs.writeSync(fd, "x", 3);
    fs.closeSync(fd);
    return fs.readFileSync(j(r, "f"));
  } },
  { name: "write on read-only fd", run: (fs, r) => (write(fs, j(r, "f")), fs.writeSync(fs.openSync(j(r, "f"), "r"), "y")) },
  { name: "read on write-only fd", run: (fs, r) => fs.readSync(fs.openSync(j(r, "f"), "w"), Buffer.alloc(4)) },
  { name: "use closed fd", run: (fs, r) => {
    const fd = fs.openSync(j(r, "f"), "w");
    fs.closeSync(fd);
    return fs.fstatSync(fd);
  } },
  { name: "append-mode positional write", run: (fs, r) => {
    write(fs, j(r, "f"), "abc");
    const fd = fs.openSync(j(r, "f"), "a");
    fs.writeSync(fd, "Z", 0);
    fs.closeSync(fd);
    return fs.readFileSync(j(r, "f"), "utf8");
  }, diverges: ["darwin"] },
  { name: "ftruncate read-only fd", run: (fs, r) => (write(fs, j(r, "f")), fs.ftruncateSync(fs.openSync(j(r, "f"), "r"), 0)) },
  { name: "ftruncate", run: (fs, r) => {
    const fd = fs.openSync(j(r, "f"), "w+");
    fs.writeSync(fd, "abcdef");
    fs.ftruncateSync(fd, 2);
    const size = fs.fstatSync(fd).size;
    fs.closeSync(fd);
    return size;
  } },
  { name: "directory fd", run: (fs, r) => {
    const fd = fs.openSync(r, "r");
    const isDir = fs.fstatSync(fd).isDirectory();
    try {
      fs.readSync(fd, Buffer.alloc(4));
      return "read succeeded";
    } catch (e) {
      return [isDir, (e as NodeJS.ErrnoException).code];
    } finally {
      fs.closeSync(fd);
    }
  } },
  { name: "open directory for writing", run: (fs, r) => fs.openSync(r, "w") },
  { name: "unlinked open file stays readable", run: (fs, r) => {
    write(fs, j(r, "f"), "still here");
    const fd = fs.openSync(j(r, "f"), "r");
    fs.unlinkSync(j(r, "f"));
    const buf = Buffer.alloc(20);
    const n = fs.readSync(fd, buf, 0, 20, 0);
    fs.closeSync(fd);
    return [fs.existsSync(j(r, "f")), buf.subarray(0, n).toString()];
  } },

  // ---- async APIs
  { name: "promises readFile missing", run: (fs, r) => fs.promises.readFile(j(r, "missing")) },
  { name: "promises write/read/readdir", run: async (fs, r) => {
    await fs.promises.mkdir(j(r, "p", "q"), { recursive: true });
    await fs.promises.writeFile(j(r, "p", "q", "f"), "promised");
    return [await fs.promises.readFile(j(r, "p", "q", "f"), "utf8"), await fs.promises.readdir(j(r, "p"))];
  } },
  { name: "promises FileHandle", run: async (fs, r) => {
    const handle = await fs.promises.open(j(r, "h"), "w+");
    await handle.write("handle data");
    const { bytesRead, buffer } = await handle.read(Buffer.alloc(6), 0, 6, 0);
    const stat = await handle.stat();
    await handle.close();
    return [bytesRead, buffer.toString(), stat.size];
  } },
  { name: "callback readFile missing is async", run: (fs, r) => new Promise((resolve) => {
    let sync = true;
    fs.readFile(j(r, "missing"), (err) => resolve([sync, err?.code, err?.syscall]));
    sync = false;
  }) },
  { name: "callback mkdir/stat", run: (fs, r) => new Promise((resolve, reject) => {
    fs.mkdir(j(r, "cb"), (err) => {
      if (err) return reject(err);
      fs.stat(j(r, "cb"), (err2, stats) => (err2 ? reject(err2) : resolve(stats.isDirectory())));
    });
  }) },
  { name: "read stream with start/end", run: (fs, r) => new Promise((resolve, reject) => {
    write(fs, j(r, "s"), "0123456789");
    const chunks: string[] = [];
    fs.createReadStream(j(r, "s"), { start: 2, end: 5, encoding: "utf8" })
      .on("data", (c) => chunks.push(c as string))
      .on("error", reject)
      .on("close", () => resolve(chunks.join("")));
  }) },
  { name: "read stream missing file", run: (fs, r) => new Promise((resolve) => {
    fs.createReadStream(j(r, "missing")).on("error", (e: NodeJS.ErrnoException) => resolve([e.code, e.syscall]));
  }) },
  { name: "write stream", run: (fs, r) => new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(j(r, "ws"));
    ws.write("a");
    ws.write(Buffer.from("b"));
    ws.end("c", () => resolve(fs.readFileSync(j(r, "ws"), "utf8")));
    ws.on("error", reject);
  }) },

  // ---- argument validation
  { name: "null byte in path", run: (fs, r) => fs.readFileSync(`${r}/a\u0000b`) },
  { name: "bad flag", run: (fs, r) => fs.openSync(j(r, "f"), "zz") },
  { name: "callback missing", run: (fs, r) => (fs.readFile as unknown as (p: string) => void)(j(r, "f")) },
];

describe("native fs compatibility", () => {
  for (const scenario of scenarios) {
    const diverges = scenario.diverges?.includes(process.platform) ?? false;
    it.skipIf(diverges)(scenario.name, async () => {
      const { native, memspace } = await compare(scenario);
      expect(memspace).toEqual(native);
    });
  }
});

export { scenarios };
