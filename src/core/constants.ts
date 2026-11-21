/**
 * Filesystem constants.
 *
 * Numeric open flags differ between platforms (O_CREAT is 0x40 on Linux and
 * 0x200 on macOS), so Memspace re-uses the host's constant table. This lets
 * code that passes `fs.constants.O_CREAT` from `node:fs` work unchanged.
 * Importing the constants table performs no filesystem I/O; it is the only
 * thing Memspace takes from `node:fs` (enforced by tests/unit/zero-disk.test.ts).
 */
import { constants as hostConstants } from "node:fs";

export const constants: typeof hostConstants = Object.freeze({ ...hostConstants });

export const S_IFMT = 0o170000;
export const S_IFREG = 0o100000;
export const S_IFDIR = 0o040000;
export const S_IFLNK = 0o120000;

export const F_OK = 0;
export const X_OK = 1;
export const W_OK = 2;
export const R_OK = 4;

export const COPYFILE_EXCL = 1;
export const COPYFILE_FICLONE = 2;
export const COPYFILE_FICLONE_FORCE = 4;

export const DEFAULT_FILE_MODE = 0o666;
export const DEFAULT_DIR_MODE = 0o777;
export const DEFAULT_SYMLINK_MODE = 0o777;
export const DEFAULT_UMASK = 0o022;

/** Value reported in `Stats.dev`. Arbitrary but stable, so tools comparing dev+ino behave. */
export const VIRTUAL_DEVICE_ID = 0x6d656d; // "mem"
export const BLOCK_SIZE = 4096;
