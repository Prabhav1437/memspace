import { invalidArgType, invalidArgValue } from "../errors/index.js";

export type Encoding = BufferEncoding | "buffer";

/** Data accepted by write-style calls. */
export type WriteData = string | NodeJS.ArrayBufferView;

export function assertEncoding(encoding: unknown): asserts encoding is Encoding | null | undefined {
  if (encoding === undefined || encoding === null || encoding === "buffer") return;
  if (typeof encoding !== "string" || !Buffer.isEncoding(encoding)) {
    throw invalidArgValue("encoding", encoding, "is invalid encoding");
  }
}

/**
 * Normalize the `options` argument many fs calls accept as either an encoding
 * string or an options object.
 */
export function normalizeOptions<T extends object>(
  options: T | string | null | undefined,
  defaults: T,
): T & { encoding?: Encoding | null } {
  if (options === undefined || options === null) return { ...defaults };
  if (typeof options === "string") {
    assertEncoding(options);
    return { ...defaults, encoding: options };
  }
  if (typeof options !== "object") throw invalidArgType("options", "of type string or an instance of Object", options);
  const merged = { ...defaults, ...options } as T & { encoding?: unknown };
  assertEncoding(merged.encoding);
  return merged as T & { encoding?: Encoding | null };
}

/** View (not copy) the bytes of a string or ArrayBufferView. */
export function toBuffer(data: unknown, encoding: Encoding | null | undefined = "utf8", name = "data"): Buffer {
  if (typeof data === "string") {
    return Buffer.from(data, encoding && encoding !== "buffer" ? encoding : "utf8");
  }
  if (Buffer.isBuffer(data)) return data;
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  throw invalidArgType(
    name,
    "of type string or an instance of Buffer, TypedArray, or DataView",
    data,
  );
}

/** Copy bytes out of the store and decode if an encoding was requested. */
export function decode(bytes: Buffer, encoding: Encoding | null | undefined): string | Buffer {
  if (encoding && encoding !== "buffer") return bytes.toString(encoding);
  return bytes;
}

export function encodeName(name: string, encoding: Encoding | null | undefined): string | Buffer {
  return encoding === "buffer" ? Buffer.from(name, "utf8") : name;
}
