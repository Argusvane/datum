// A gzip-compressed tar archive written the same way every time: the entries in the order given, one
// modification time for all of them, no owner names. The system's tar differs between macOS and Linux in
// the flags that would give this, so the archive is written here: ustar headers, with a pax extended
// header before an entry whose path does not fit the ustar name and prefix fields.
import { createWriteStream, readFileSync } from "node:fs";
import { once } from "node:events";
import { createGzip } from "node:zlib";

const BLOCK = 512;

/** The ustar `{ name, prefix }` of a path, or undefined when it does not fit (name 100 bytes, prefix 155, split at a `/`). */
export function splitPath(path) {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: "" };
  for (let at = path.indexOf("/"); at >= 0; at = path.indexOf("/", at + 1)) {
    const prefix = path.slice(0, at);
    const name = path.slice(at + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100 && name !== "") return { name, prefix };
  }
  return undefined;
}

function header({ name, prefix = "", size, mtime, type = "0", mode = 0o644 }) {
  const block = Buffer.alloc(BLOCK);
  const octal = (value, length) => value.toString(8).padStart(length - 1, "0") + "\0";
  block.write(name, 0, 100, "utf8");
  block.write(octal(mode, 8), 100, 8, "ascii");
  block.write(octal(0, 8), 108, 8, "ascii");
  block.write(octal(0, 8), 116, 8, "ascii");
  block.write(octal(size, 12), 124, 12, "ascii");
  block.write(octal(mtime, 12), 136, 12, "ascii");
  block.write("        ", 148, 8, "ascii");
  block.write(type, 156, 1, "ascii");
  block.write("ustar\0", 257, 6, "ascii");
  block.write("00", 263, 2, "ascii");
  block.write(prefix, 345, 155, "utf8");
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return block;
}

const padded = (data) => {
  const rest = data.length % BLOCK;
  return rest === 0 ? data : Buffer.concat([data, Buffer.alloc(BLOCK - rest)]);
};

/** A pax record: its own length, a space, `key=value` and a newline (the length counts itself). */
function paxRecord(key, value) {
  const body = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(body) + 1;
  while (Buffer.byteLength(`${length}${body}`) !== length) length = Buffer.byteLength(`${length}${body}`);
  return `${length}${body}`;
}

/** The tar blocks of one entry: `path` inside the archive, `data` a Buffer, `mtime` in seconds. */
export function tarEntry(path, data, mtime) {
  const split = splitPath(path);
  if (split !== undefined) return Buffer.concat([header({ ...split, size: data.length, mtime }), padded(data)]);
  const pax = Buffer.from(paxRecord("path", path), "utf8");
  // The name of the entry itself is a truncation: a reader that knows pax takes the path from the record.
  const short = Buffer.from(path, "utf8").subarray(-100).toString("utf8").replace(/^[^/]*\//, "");
  return Buffer.concat([
    header({ name: "PaxHeader", size: pax.length, mtime, type: "x" }),
    padded(pax),
    header({ name: short, size: data.length, mtime }),
    padded(data)
  ]);
}

/**
 * Writes `<file>` as a .tar.gz of `entries` (`[{ path, from }]`: the path inside the archive and the file
 * it is read from), in the order given, every entry with `mtime` (seconds). Resolves when the file is closed.
 */
export async function writeTarGz(file, entries, { mtime = 0 } = {}) {
  const gzip = createGzip({ level: 9 });
  const out = createWriteStream(file);
  gzip.pipe(out);
  for (const entry of entries) {
    if (!gzip.write(tarEntry(entry.path, readFileSync(entry.from), mtime))) await once(gzip, "drain");
  }
  gzip.end(Buffer.alloc(BLOCK * 2));
  await once(out, "close");
}
