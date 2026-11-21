import { invalidArgValue, invalidArgType } from "../errors/index.js";
import { constants } from "./constants.js";

/** Decoded open flags. */
export interface OpenFlags {
  readable: boolean;
  writable: boolean;
  append: boolean;
  create: boolean;
  exclusive: boolean;
  truncate: boolean;
  /** O_DIRECTORY: fail with ENOTDIR unless the target is a directory. */
  directory: boolean;
  /** O_NOFOLLOW: fail with ELOOP if the final component is a symlink. */
  noFollow: boolean;
}

const STRING_FLAGS: Record<string, Omit<OpenFlags, "directory" | "noFollow">> = {
  r: { readable: true, writable: false, append: false, create: false, exclusive: false, truncate: false },
  rs: { readable: true, writable: false, append: false, create: false, exclusive: false, truncate: false },
  sr: { readable: true, writable: false, append: false, create: false, exclusive: false, truncate: false },
  "r+": { readable: true, writable: true, append: false, create: false, exclusive: false, truncate: false },
  "rs+": { readable: true, writable: true, append: false, create: false, exclusive: false, truncate: false },
  "sr+": { readable: true, writable: true, append: false, create: false, exclusive: false, truncate: false },
  w: { readable: false, writable: true, append: false, create: true, exclusive: false, truncate: true },
  wx: { readable: false, writable: true, append: false, create: true, exclusive: true, truncate: true },
  xw: { readable: false, writable: true, append: false, create: true, exclusive: true, truncate: true },
  "w+": { readable: true, writable: true, append: false, create: true, exclusive: false, truncate: true },
  "wx+": { readable: true, writable: true, append: false, create: true, exclusive: true, truncate: true },
  "xw+": { readable: true, writable: true, append: false, create: true, exclusive: true, truncate: true },
  a: { readable: false, writable: true, append: true, create: true, exclusive: false, truncate: false },
  ax: { readable: false, writable: true, append: true, create: true, exclusive: true, truncate: false },
  xa: { readable: false, writable: true, append: true, create: true, exclusive: true, truncate: false },
  as: { readable: false, writable: true, append: true, create: true, exclusive: false, truncate: false },
  sa: { readable: false, writable: true, append: true, create: true, exclusive: false, truncate: false },
  "a+": { readable: true, writable: true, append: true, create: true, exclusive: false, truncate: false },
  "ax+": { readable: true, writable: true, append: true, create: true, exclusive: true, truncate: false },
  "xa+": { readable: true, writable: true, append: true, create: true, exclusive: true, truncate: false },
  "as+": { readable: true, writable: true, append: true, create: true, exclusive: false, truncate: false },
  "sa+": { readable: true, writable: true, append: true, create: true, exclusive: false, truncate: false },
};

export type OpenMode = string | number;

/** Parse a string (`'r+'`) or numeric (`O_RDWR | O_CREAT`) flag value. */
export function parseFlags(flags: OpenMode | undefined | null, fallback = "r"): OpenFlags {
  const value = flags ?? fallback;
  if (typeof value === "string") {
    const known = STRING_FLAGS[value];
    if (!known) throw invalidArgValue("flags", value);
    return { ...known, directory: false, noFollow: false };
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw invalidArgType("flags", "of type string or number", value);
  }
  const access = value & 3; // O_RDONLY=0, O_WRONLY=1, O_RDWR=2 on all supported platforms
  const has = (flag: number | undefined) => flag !== undefined && flag !== 0 && (value & flag) === flag;
  return {
    readable: access === constants.O_RDONLY || access === constants.O_RDWR,
    writable: access === constants.O_WRONLY || access === constants.O_RDWR,
    append: has(constants.O_APPEND),
    create: has(constants.O_CREAT),
    exclusive: has(constants.O_EXCL),
    truncate: has(constants.O_TRUNC),
    directory: has(constants.O_DIRECTORY),
    noFollow: has(constants.O_NOFOLLOW),
  };
}
