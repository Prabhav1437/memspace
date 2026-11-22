/**
 * Binary processing: generate, transform and inspect binary files with streams and descriptors.
 * Run: npx tsx examples/binary-processing.ts
 */
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createHash } from "node:crypto";
import { createFs } from "memspace-fs";

const fs = createFs();

// Write a 4 MiB file of pseudo-random bytes.
const input = Buffer.alloc(4 * 1024 * 1024);
for (let i = 0; i < input.length; i++) input[i] = (i * 2654435761) >>> 24;
fs.writeFileSync("/input.bin", input);

// Stream it through an XOR transform into another in-memory file.
const xor = new Transform({
  transform(chunk: Buffer, _enc, done) {
    for (let i = 0; i < chunk.length; i++) chunk[i] ^= 0x5a;
    done(null, chunk);
  },
});
await pipeline(fs.createReadStream("/input.bin"), xor, fs.createWriteStream("/output.bin"));

// Patch a header in place through a descriptor.
const fd = fs.openSync("/output.bin", "r+");
fs.writeSync(fd, Buffer.from("MSPC"), 0, 4, 0);
const header = Buffer.alloc(4);
fs.readSync(fd, header, 0, 4, 0);
fs.closeSync(fd);

const digest = createHash("sha256").update(fs.readFileSync("/output.bin")).digest("hex");
console.log({ header: header.toString(), size: fs.statSync("/output.bin").size, sha256: digest.slice(0, 16) });
