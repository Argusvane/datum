import { createHash } from "node:crypto";

/**
 * An independent reader of the engine's canonical form: it shares no code with
 * the kernel's `kernelStableStringify` or its SHA-256, so a mistake in either shows as a
 * disagreement here instead of agreeing with itself.
 *
 * The form: leaves as `JSON.stringify` writes them (a number as ECMAScript prints it, a text with
 * the standard escapes, lone surrogates escaped), arrays in order, objects with no whitespace and
 * their keys in the order a JavaScript engine lists them after sorting: array-index keys
 * (`0`..`4294967294`, no leading zero) first and ascending, every other key after in UTF-16
 * code-unit order. A member whose value is `undefined` is left out, in an array it is `null`.
 * This is the order the engine's browser-side serializer and the sandbox both produce
 * (the case "integer-like keys first" pins it).
 */
export function canonicalText(value: unknown): string {
  const text = write(value);
  return text === undefined ? "null" : text;
}

function isArrayIndex(key: string): boolean {
  if (!/^(?:0|[1-9][0-9]*)$/.test(key)) {
    return false;
  }
  return Number(key) < 4294967295;
}

function write(value: unknown): string | undefined {
  if (value === undefined || typeof value === "function" || typeof value === "symbol") {
    return undefined;
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => write(item) ?? "null").join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  const indexes = keys.filter(isArrayIndex).sort((a, b) => Number(a) - Number(b));
  const others = keys.filter((key) => !isArrayIndex(key)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const members: string[] = [];
  for (const key of [...indexes, ...others]) {
    const text = write(record[key]);
    if (text !== undefined) {
      members.push(`${JSON.stringify(key)}:${text}`);
    }
  }
  return `{${members.join(",")}}`;
}

/** Lowercase hex SHA-256 of the text's UTF-8 bytes (a lone surrogate encodes as U+FFFD, as `TextEncoder` does). */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

/** The canonical text of a document and the digest of that text: what a run returns for `document`. */
export function referenceDigest(document: unknown): { canonical: string; digest: string } {
  const canonical = canonicalText(document);
  return { canonical, digest: sha256Hex(canonical) };
}
