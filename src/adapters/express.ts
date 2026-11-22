/**
 * Optional Express integration (`memspace-fs/express`).
 *
 * The adapter has no runtime dependency on Express and works with Express 4
 * and 5 (the middleware signature is identical in both). It never creates
 * request-scoped filesystems implicitly: you pass the instance you want to
 * share, and every request sees that same instance. A shared instance is NOT
 * tenant isolation; create one instance per tenant if you need that.
 *
 * Concurrency: every Memspace operation is atomic and runs to completion on
 * the event loop, so concurrent requests never observe half-written files.
 * Multi-step sequences (read-modify-write) can still interleave across
 * `await` points, exactly as they would on a real disk.
 */
import { posix } from "node:path";
import { createFs, VirtualFileSystem } from "../index.js";
import type { Stats } from "../metadata/stats.js";

export { createFs, VirtualFileSystem };

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Memspace instance attached by `expressMiddleware(fs, { attachToRequest: true })`. */
      memspace?: VirtualFileSystem;
    }
    interface Locals {
      /** Memspace instance attached by `expressMiddleware(fs)`. */
      memspace?: VirtualFileSystem;
    }
  }
}

/**
 * Minimal structural types so this module needs neither `express` nor
 * `@types/express` at runtime. Express's own Request/Response satisfy them.
 */
export interface RequestLike {
  method?: string;
  path?: string;
  url?: string;
}
export interface ResponseLike {
  locals: Record<string, unknown>;
  headersSent?: boolean;
  setHeader(name: string, value: string | number): unknown;
  status(code: number): ResponseLike;
  end(): unknown;
  end(chunk: string): unknown;
}
export interface NextFunction {
  (error?: unknown): void;
}
/** An Express-compatible `(req, res, next)` handler. Declared as a method type so it is bivariant in its parameters. */
export type Middleware = {
  handle(req: RequestLike, res: ResponseLike, next: NextFunction): void;
}["handle"];

export interface ExpressMiddlewareOptions {
  /** Also expose the instance on the request object. Default: false. */
  attachToRequest?: boolean;
  /** Request property name when `attachToRequest` is set. Default: `"memspace"`. */
  property?: string;
  /** `res.locals` key the instance is always exposed under. Default: `"memspace"`. */
  localsKey?: string;
}

/**
 * Type helper for a custom request property:
 * `app.get("/", (req: MemspaceRequest<Request, "space">, res) => req.space.readFileSync(...))`.
 */
export type MemspaceRequest<Req, Property extends string = "memspace"> = Req & { [K in Property]: VirtualFileSystem };

/**
 * Make a shared Memspace instance available to route handlers via
 * `res.locals.memspace` (and optionally `req[property]`). Requests made after
 * the instance is disposed are passed to `next()` with an error.
 */
export function expressMiddleware(fs: VirtualFileSystem, options: ExpressMiddlewareOptions = {}): Middleware {
  if (!(fs instanceof VirtualFileSystem)) throw new TypeError("expressMiddleware() expects a Memspace instance");
  const property = options.property ?? "memspace";
  const localsKey = options.localsKey ?? "memspace";
  return (req, res, next) => {
    if (fs.isDisposed) {
      next(Object.assign(new Error(`Memspace instance "${fs.name}" has been disposed`), { code: "ERR_MEMSPACE_DISPOSED", status: 503 }));
      return;
    }
    res.locals[localsKey] = fs;
    if (options.attachToRequest) (req as Record<string, unknown>)[property] = fs;
    next();
  };
}

export interface ServeOptions {
  /** Directory inside the virtual filesystem to serve. Default: `"/"`. */
  root?: string;
  /** File served for directory requests. Default: `"index.html"`; `false` disables. */
  index?: string | false;
  /** Pass to `next()` (instead of responding 404) when a file is missing. Default: true. */
  fallthrough?: boolean;
  /** Extra content types keyed by extension (".md": "text/markdown"). */
  contentTypes?: Record<string, string>;
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".xml": "application/xml",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
  ".wasm": "application/wasm",
  ".zip": "application/zip",
};

/**
 * Serve files from a Memspace instance (GET/HEAD only), streaming content.
 * Paths are resolved inside `root`; `..` can never leave it.
 */
export function serveStatic(fs: VirtualFileSystem, options: ServeOptions = {}): Middleware {
  const root = posix.resolve("/", options.root ?? "/");
  const index = options.index ?? "index.html";
  const fallthrough = options.fallthrough ?? true;
  const types = { ...CONTENT_TYPES, ...options.contentTypes };

  return (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    let requestPath: string;
    try {
      requestPath = decodeURIComponent((req.path ?? req.url ?? "/").split("?")[0]!);
    } catch {
      return void res.status(400).end("Bad Request");
    }
    // Normalize against a fake root first so ".." cannot climb above `root`.
    let target = posix.join(root, posix.resolve("/", requestPath));
    let stats: Stats | undefined;
    try {
      stats = fs.statSync(target, { throwIfNoEntry: false });
      if (stats?.isDirectory() && index) {
        target = posix.join(target, index);
        stats = fs.statSync(target, { throwIfNoEntry: false });
      }
    } catch (error) {
      return next(error);
    }
    if (!stats || !stats.isFile()) {
      if (fallthrough) return next();
      return void res.status(404).end("Not Found");
    }
    res.setHeader("Content-Type", types[posix.extname(target).toLowerCase()] ?? "application/octet-stream");
    res.setHeader("Content-Length", stats.size);
    res.setHeader("Last-Modified", stats.mtime.toUTCString());
    if (req.method === "HEAD") return void res.end();
    const stream = fs.createReadStream(target);
    stream.on("error", (error) => {
      if (res.headersSent) stream.destroy();
      else next(error);
    });
    stream.pipe(res as unknown as NodeJS.WritableStream);
  };
}
