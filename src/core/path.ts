/**
 * Path handling for the virtual namespace.
 *
 * Memspace always uses POSIX semantics, independent of the host platform:
 * `/` is the only separator, the namespace has a single root, and `..` at the
 * root stays at the root, so no path can escape the virtual filesystem.
 */
import { codedError, invalidArgType, invalidArgValue } from "../errors/index.js";

export type PathLike = string | Buffer | URL;

/** Convert a `PathLike` argument to a string, validating it like Node does. */
export function pathToString(value: unknown, name = "path"): string {
  let result: string;
  if (typeof value === "string") {
    result = value;
  } else if (Buffer.isBuffer(value)) {
    result = value.toString("utf8");
  } else if (value instanceof Uint8Array) {
    result = Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("utf8");
  } else if (value instanceof URL) {
    result = fileUrlToPath(value);
  } else {
    throw invalidArgType(name, "of type string or an instance of Buffer or URL", value);
  }
  if (result.includes("\u0000")) {
    throw invalidArgValue(name, result, "must be a string, Uint8Array, or URL without null bytes");
  }
  return result;
}

function fileUrlToPath(url: URL): string {
  if (url.protocol !== "file:") {
    throw codedError("ERR_INVALID_URL_SCHEME", "The URL must be of scheme file", TypeError);
  }
  if (url.hostname !== "" && url.hostname !== "localhost") {
    throw codedError("ERR_INVALID_FILE_URL_HOST", `File URL host must be "localhost" or empty`, TypeError);
  }
  const pathname = url.pathname;
  if (/%2f/i.test(pathname)) {
    throw codedError("ERR_INVALID_FILE_URL_PATH", "File URL path must not include encoded / characters", TypeError);
  }
  return decodeURIComponent(pathname);
}

/** Split a path into components, resolving `.` and `..` and collapsing repeated slashes. */
export function splitComponents(absolute: string): string[] {
  const out: string[] = [];
  for (const part of absolute.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      out.pop(); // `..` above the root stays at the root
      continue;
    }
    out.push(part);
  }
  return out;
}

/** Resolve `input` against `cwd` and normalize it to a canonical absolute path. */
export function resolvePath(cwd: string, input: string): string {
  const joined = input.startsWith("/") ? input : `${cwd}/${input}`;
  return `/${splitComponents(joined).join("/")}`;
}

/** True when the original path string ends with a separator (meaning "must be a directory"). */
export function hasTrailingSlash(input: string): boolean {
  return input.length > 1 && (input.endsWith("/") || input.endsWith("/.") || input.endsWith("/.."));
}

export function joinPath(dir: string, name: string): string {
  return dir === "/" ? `/${name}` : `${dir}/${name}`;
}

export function dirname(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
}

export function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Path of `target` relative to directory `from`, both canonical absolute paths. */
export function relativePath(from: string, target: string): string {
  if (from === target) return "";
  const prefix = from === "/" ? "/" : `${from}/`;
  return target.startsWith(prefix) ? target.slice(prefix.length) : target;
}

/** True when `child` is `parent` itself or lies beneath it. */
export function isSubpath(parent: string, child: string): boolean {
  if (parent === "/") return true;
  return child === parent || child.startsWith(`${parent}/`);
}

export const MAX_NAME_LENGTH = 255;
export const MAX_PATH_LENGTH = 4096;
