/**
 * The `file` component: a control that takes files from the person filling the form and
 * carries them into form state as attachments.
 *
 * Two choices here leave room for other storage kinds.
 * An attachment records *how* its bytes are stored (`storage`) beside what every file has —
 * name, type, size. The only kind this build knows is `base64`, which embeds the bytes in the
 * value itself; a host that puts files in a bucket and keeps a link is a second kind with the
 * same envelope, not a second component. And the component's configuration names the storage
 * kind, so a form moves from embedded bytes to a bucket by changing one property, with every
 * rule, constraint and renderer that reads the field unchanged.
 */

/** Component type of a file-upload control in the canonical model. */
export const FILE_COMPONENT_TYPE = "file";

/**
 * The storage kinds the engine itself ships. A closed union for the same reason
 * `ButtonAction` is: the builder offers exactly these, and adding one (`"s3"`, `"server"`)
 * is a line here that every exhaustive switch will then flag. A host's own kind is a plain
 * string on the wire — see `FileStorage` in `render/core/file-storage.ts`.
 */
export type FileStorageKind = "base64";

export interface FileStorageOption {
  value: FileStorageKind;
  /** Human-readable choice for a builder's storage picker. */
  label: string;
  description: string;
}

/** The storage vocabulary, in the order a builder should present it. */
export const FILE_STORAGE_OPTIONS: FileStorageOption[] = [
  {
    value: "base64",
    label: "Embed as base64",
    description: "The file's bytes travel inside the form's values, so a submission is self-contained."
  }
];

/** What a `file` component uses when its configuration names no storage. */
export const DEFAULT_FILE_STORAGE: FileStorageKind = "base64";

/**
 * One stored file, whichever storage carried it. The common envelope is what every consumer
 * can rely on — a read-only rendering lists names and sizes without knowing where the bytes
 * went — and `storage` says which specialization to expect beyond it.
 */
export interface FileAttachment {
  /** The storage kind that carried the bytes; decides which further fields are present. */
  storage: string;
  /** The file's name as picked, extension included. */
  name: string;
  /** MIME type as the browser reported it; empty when it could not tell. */
  type: string;
  /** Size of the original file, in bytes. */
  size: number;
}

/** An attachment whose bytes are embedded in the value itself. */
export interface Base64FileAttachment extends FileAttachment {
  storage: "base64";
  /** The bytes, base64-encoded, with no `data:` prefix. */
  data: string;
}

export function isFileAttachment(value: unknown): value is FileAttachment {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.storage === "string" &&
    record.storage.length > 0 &&
    typeof record.name === "string" &&
    typeof record.type === "string" &&
    typeof record.size === "number" &&
    Number.isFinite(record.size)
  );
}

export function isBase64FileAttachment(value: unknown): value is Base64FileAttachment {
  return (
    isFileAttachment(value) &&
    value.storage === "base64" &&
    typeof (value as { data?: unknown }).data === "string"
  );
}

/**
 * The attachments a `file` component's value holds: one for a single-file field, a list for
 * a multi-file one, and nothing for anything that is not an attachment at all — a value
 * left over from the field being some other type, or a hand-edited draft.
 */
export function readFileAttachments(value: unknown): FileAttachment[] {
  if (Array.isArray(value)) {
    return value.filter(isFileAttachment);
  }
  return isFileAttachment(value) ? [value] : [];
}

/** What the component's configuration says about the control, read once for every surface. */
export interface FileUploadConfiguration {
  /** The storage kind picked files go through. Unknown kinds pass through, as a button's action does. */
  storage: string;
  /** Whether the control takes more than one file; the value is then a list. */
  multiple: boolean;
  /**
   * What the control accepts, as normalized tokens: `.pdf`, `image/*`, `application/zip`.
   * Empty means anything. The same syntax as the `accept` attribute, which is what the markup
   * emits it as — a hint to the picker; the field-constraints stage is the check.
   */
  accept: string[];
  /** Per-file ceiling in bytes; `undefined` when the author set none. */
  maxFileSize: number | undefined;
}

export const BYTES_PER_MEGABYTE = 1024 * 1024;

const EXTENSION_TOKEN = /^\.[a-z0-9][a-z0-9.+-]*$/;
const MIME_TOKEN = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/(\*|[a-z0-9][a-z0-9!#$&^_.+-]*)$/;

/**
 * Accept tokens from an authored value — a comma-separated string, the way the HTML attribute
 * is written, or a list. Lower-cased, trimmed and de-duplicated; a token that is neither an
 * extension nor a MIME type is dropped rather than emitted into an attribute the browser would
 * misread.
 */
export function readAcceptTokens(raw: unknown): string[] {
  const parts =
    typeof raw === "string"
      ? raw.split(",")
      : Array.isArray(raw)
        ? raw.filter((entry): entry is string => typeof entry === "string")
        : [];
  const out: string[] = [];
  for (const part of parts) {
    const token = part.trim().toLowerCase();
    if (token.length === 0 || out.includes(token)) {
      continue;
    }
    if (EXTENSION_TOKEN.test(token) || MIME_TOKEN.test(token)) {
      out.push(token);
    }
  }
  return out;
}

/**
 * A `file` component's own configuration.
 *
 * The size limit is authored in megabytes (`maxFileSizeMb`) because that is the unit a person
 * thinks in, and read out in bytes because that is the unit a file reports. Zero, negative or
 * unreadable means no limit, as an unreadable length limit does.
 */
export function readFileUploadConfiguration(configuration: unknown): FileUploadConfiguration {
  if (!configuration || typeof configuration !== "object" || Array.isArray(configuration)) {
    return { storage: DEFAULT_FILE_STORAGE, multiple: false, accept: [], maxFileSize: undefined };
  }
  const record = configuration as Record<string, unknown>;
  const storage =
    typeof record.storage === "string" && record.storage.trim().length > 0
      ? record.storage.trim()
      : DEFAULT_FILE_STORAGE;
  const megabytes = record.maxFileSizeMb;
  const bytes =
    typeof megabytes === "number" && Number.isFinite(megabytes) && megabytes > 0
      ? Math.floor(megabytes * BYTES_PER_MEGABYTE)
      : 0;
  return {
    storage,
    multiple: record.multiple === true,
    accept: readAcceptTokens(record.accept),
    maxFileSize: bytes >= 1 ? bytes : undefined
  };
}

/**
 * Whether a file is one the `accept` tokens admit. An extension token matches the end of the
 * name, a `type/*` token the start of the MIME type, and a full MIME token the type exactly —
 * the same reading browsers give the attribute. No tokens admits everything.
 */
export function matchesAccept(
  file: Pick<FileAttachment, "name" | "type">,
  accept: readonly string[]
): boolean {
  if (accept.length === 0) {
    return true;
  }
  const name = file.name.toLowerCase();
  const type = file.type.toLowerCase();
  return accept.some((token) => {
    if (token.startsWith(".")) {
      return name.endsWith(token);
    }
    if (token.endsWith("/*")) {
      return type.startsWith(token.slice(0, -1));
    }
    return type === token;
  });
}

/**
 * A size for a person to read: `512 B`, `12 KB`, `1.5 MB`. One decimal under ten units, none
 * above, and no locale APIs — the WASM kernel formats the same numbers for its error
 * parameters and the two must agree byte for byte.
 */
export function formatFileSize(bytes: number): string {
  const size = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  const trim = (value: number): string => String(value >= 10 ? Math.round(value) : Math.round(value * 10) / 10);
  if (size < 1024) {
    return `${Math.round(size)} B`;
  }
  if (size < BYTES_PER_MEGABYTE) {
    return `${trim(size / 1024)} KB`;
  }
  if (size < BYTES_PER_MEGABYTE * 1024) {
    return `${trim(size / BYTES_PER_MEGABYTE)} MB`;
  }
  return `${trim(size / (BYTES_PER_MEGABYTE * 1024))} GB`;
}

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** The alphabet as char codes, for the decoder's table. */
const BASE64_CODES: number[] = Array.from(BASE64_ALPHABET, (char) => char.charCodeAt(0));

/** Every pair of sextets as its two characters: two lookups per three bytes, no string made per call. */
const BASE64_PAIRS: string[] = Array.from({ length: 4096 }, (_, n) => BASE64_ALPHABET[n >> 6]! + BASE64_ALPHABET[n & 63]!);

/** Pairs joined at a time: 3 KiB of input to a 4 KiB flat string. */
const BASE64_CHUNK_PAIRS = 2048;

/**
 * Base64 with no `btoa`: the same bytes encode the same way on every runtime. Written for an
 * interpreter as much as for a JIT — a megabyte of upload or font passes through here inside
 * the sandbox — so each three bytes cost two table lookups and two array pushes, and the
 * string is made by joining. Neither `+=` (quickjs-ng builds a rope node per append, and a
 * few million of them exhaust the sandbox) nor `String.fromCharCode.apply` over a chunk
 * (which leaks there at a few megabytes and fails the runtime's own assertion when freed).
 */
export function bytesToBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  const chunk: string[] = [];
  const length = bytes.length;
  let i = 0;
  for (; i + 2 < length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    chunk.push(BASE64_PAIRS[n >> 12]!, BASE64_PAIRS[n & 4095]!);
    if (chunk.length >= BASE64_CHUNK_PAIRS) {
      parts.push(chunk.join(""));
      chunk.length = 0;
    }
  }
  if (i < length) {
    const rest = length - i;
    const n = (bytes[i]! << 16) | (rest === 2 ? bytes[i + 1]! << 8 : 0);
    chunk.push(BASE64_PAIRS[n >> 12]!, rest === 2 ? BASE64_ALPHABET[(n >> 6) & 63]! : "=", "=");
  }
  if (chunk.length > 0) {
    parts.push(chunk.join(""));
  }
  return parts.join("");
}

/** Char code → sextet; 255 for anything outside the alphabet. The URL-safe pair is accepted too. */
const BASE64_LOOKUP: Uint8Array = (() => {
  const table = new Uint8Array(256).fill(255);
  BASE64_CODES.forEach((code, index) => {
    table[code] = index;
  });
  table["-".charCodeAt(0)] = 62;
  table["_".charCodeAt(0)] = 63;
  return table;
})();

/** Base64 to bytes with no `atob`; whitespace and padding ignored, URL-safe alphabet accepted. */
export function base64ToBytes(text: string): Uint8Array {
  const length = text.length;
  const out = new Uint8Array(Math.floor((length * 3) / 4) + 2);
  let buffer = 0;
  let bits = 0;
  let index = 0;
  for (let i = 0; i < length; i += 1) {
    const code = text.charCodeAt(i);
    const value = code < 256 ? BASE64_LOOKUP[code]! : 255;
    if (value === 255) {
      // Padding and whitespace (as `\s` reads it) are skipped; anything else is not base64.
      if (code === 61 || /\s/.test(text[i]!)) {
        continue;
      }
      throw new Error(`Invalid base64 character "${text[i]}"`);
    }
    buffer = ((buffer << 6) | value) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[index] = (buffer >> bits) & 0xff;
      index += 1;
    }
  }
  return out.subarray(0, index);
}
