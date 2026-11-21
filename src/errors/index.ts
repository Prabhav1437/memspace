import { constants as osConstants } from "node:os";
import { inspect } from "node:util";

/**
 * Node.js-compatible error construction.
 *
 * Native `fs` errors are `Error` instances with `errno`, `code`, `syscall`,
 * `path` and (for two-path calls) `dest` properties, and a message of the form
 * `ENOENT: no such file or directory, open '/missing.txt'`. Memspace reproduces
 * that shape so existing `error.code` checks keep working.
 */

/** Errno codes Memspace can raise, with the Linux errno numbers Node reports (negated). */
export const ERRNO = {
  EPERM: { errno: -1, description: "operation not permitted" },
  ENOENT: { errno: -2, description: "no such file or directory" },
  EBADF: { errno: -9, description: "bad file descriptor" },
  EACCES: { errno: -13, description: "permission denied" },
  EBUSY: { errno: -16, description: "resource busy or locked" },
  EEXIST: { errno: -17, description: "file already exists" },
  EXDEV: { errno: -18, description: "cross-device link not permitted" },
  ENOTDIR: { errno: -20, description: "not a directory" },
  EISDIR: { errno: -21, description: "illegal operation on a directory" },
  EINVAL: { errno: -22, description: "invalid argument" },
  EMFILE: { errno: -24, description: "too many open files" },
  EFBIG: { errno: -27, description: "file too large" },
  ENOSPC: { errno: -28, description: "no space left on device" },
  ENAMETOOLONG: { errno: -36, description: "name too long" },
  ENOSYS: { errno: -38, description: "function not implemented" },
  ENOTEMPTY: { errno: -39, description: "directory not empty" },
  ELOOP: { errno: -40, description: "too many symbolic links encountered" },
  ENOTSUP: { errno: -95, description: "operation not supported on socket" },
} as const;

export type ErrnoCode = keyof typeof ERRNO;

/** Error thrown by every Memspace filesystem operation that fails like a syscall would. */
export interface MemspaceErrnoException extends Error {
  errno: number;
  code: ErrnoCode;
  syscall: string;
  path?: string;
  dest?: string;
}

export interface ErrnoErrorInit {
  syscall: string;
  path?: string | undefined;
  dest?: string | undefined;
  /** Extra detail appended to the message, e.g. memory quota information. */
  detail?: string | undefined;
}

/** Create a Node-style errno error (`ENOENT: no such file or directory, open '/x'`). */
export function errnoError(code: ErrnoCode, init: ErrnoErrorInit): MemspaceErrnoException {
  const { description } = ERRNO[code];
  const errno = hostErrno(code);
  let message = `${code}: ${description}, ${init.syscall}`;
  if (init.path !== undefined) message += ` '${init.path}'`;
  if (init.dest !== undefined) message += ` -> '${init.dest}'`;
  if (init.detail !== undefined) message += ` (${init.detail})`;
  const error = new Error(message) as MemspaceErrnoException;
  error.errno = errno;
  error.code = code;
  error.syscall = init.syscall;
  if (init.path !== undefined) error.path = init.path;
  if (init.dest !== undefined) error.dest = init.dest;
  return error;
}

const hostErrnoTable = osConstants.errno as Record<string, number | undefined>;

/**
 * `errno` as native fs reports it on this platform (libuv negates the OS
 * value, so ENOTEMPTY is -39 on Linux but -66 on macOS).
 */
function hostErrno(code: ErrnoCode): number {
  const value = hostErrnoTable[code];
  return value === undefined ? ERRNO[code].errno : -value;
}

/** Codes for Node's argument-validation errors (thrown synchronously, never via callback). */
export type ArgErrorCode =
  | "ERR_INVALID_ARG_TYPE"
  | "ERR_INVALID_ARG_VALUE"
  | "ERR_OUT_OF_RANGE"
  | "ERR_INVALID_URL_SCHEME"
  | "ERR_INVALID_FILE_URL_HOST"
  | "ERR_INVALID_FILE_URL_PATH"
  | "ERR_FS_CP_EINVAL"
  | "ERR_FS_CP_DIR_TO_NON_DIR"
  | "ERR_FS_CP_NON_DIR_TO_DIR"
  | "ERR_FS_CP_EEXIST"
  | "ERR_FS_EISDIR"
  | "ERR_DIR_CLOSED"
  | "ERR_DIR_CONCURRENT_OPERATION"
  | "ERR_STREAM_DESTROYED"
  | "ERR_MEMSPACE_DISPOSED"
  | "ERR_MEMSPACE_INVALID_SNAPSHOT";

export interface MemspaceCodedError extends Error {
  code: ArgErrorCode;
}

/** Create a Node-style coded error such as `TypeError [ERR_INVALID_ARG_TYPE]`. */
export function codedError(
  code: ArgErrorCode,
  message: string,
  Ctor: ErrorConstructor | TypeErrorConstructor | RangeErrorConstructor = Error,
): MemspaceCodedError {
  const error = new Ctor(message) as MemspaceCodedError;
  error.code = code;
  return error;
}

export function invalidArgType(name: string, expected: string, actual: unknown): MemspaceCodedError {
  return codedError(
    "ERR_INVALID_ARG_TYPE",
    `The "${name}" argument must be ${expected}. Received ${describe(actual)}`,
    TypeError,
  );
}

export function invalidArgValue(name: string, value: unknown, reason = "is invalid"): MemspaceCodedError {
  return codedError(
    "ERR_INVALID_ARG_VALUE",
    `The argument '${name}' ${reason}. Received ${inspect(value)}`,
    TypeError,
  );
}

export function outOfRange(name: string, range: string, value: unknown): MemspaceCodedError {
  return codedError(
    "ERR_OUT_OF_RANGE",
    `The value of "${name}" is out of range. It must be ${range}. Received ${describe(value)}`,
    RangeError,
  );
}

export function disposedError(name: string): MemspaceCodedError {
  return codedError("ERR_MEMSPACE_DISPOSED", `Memspace instance "${name}" has been disposed`);
}

export function invalidSnapshot(reason: string): MemspaceCodedError {
  return codedError("ERR_MEMSPACE_INVALID_SNAPSHOT", `Invalid Memspace snapshot: ${reason}`);
}

/** Node's AbortError shape (`name: 'AbortError'`, `code: 'ABORT_ERR'`). */
export function abortError(signal?: AbortSignal): Error {
  const error = new Error("The operation was aborted", { cause: signal?.reason }) as Error & { code: string };
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

/** True for errno-style errors raised by Memspace (or native fs). */
export function isErrnoException(value: unknown): value is MemspaceErrnoException {
  return value instanceof Error && typeof (value as { code?: unknown }).code === "string" && "syscall" in value;
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "function") return `function ${value.name || "<anonymous>"}`;
  if (typeof value === "object") {
    const ctor = (value as object).constructor?.name;
    return ctor ? `an instance of ${ctor}` : "[object]";
  }
  let shown = typeof value === "string" ? `'${value}'` : String(value);
  if (shown.length > 28) shown = `${shown.slice(0, 25)}...`;
  return `type ${typeof value} (${shown})`;
}
