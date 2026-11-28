/**
 * JSON read the way every Datum host reads a request body: `JSON.parse`, and an object that names
 * the same key twice is refused instead of keeping the last value. Another reader of the same
 * bytes (a client's preview, a signer that canonicalises the raw body) could resolve a repeated
 * key differently, so a body with one is malformed JSON and is answered as malformed JSON is.
 * Keys are compared as `JSON.parse` decodes them, so `"a"` and `"a"` are the same key.
 */

/** The error {@link parseStrictJson} throws for a repeated key: a `SyntaxError`, as `JSON.parse` throws for any other malformed text. */
export class DuplicateJsonKeyError extends SyntaxError {
  public readonly key: string;

  constructor(key: string) {
    super(`Duplicate key ${JSON.stringify(key)} in a JSON object`);
    this.name = "DuplicateJsonKeyError";
    this.key = key;
  }
}

/** `JSON.parse(text)`, refusing an object with a repeated key ({@link DuplicateJsonKeyError}). */
export function parseStrictJson(text: string): unknown {
  const value: unknown = JSON.parse(text);
  assertNoDuplicateKeys(text);
  return value;
}

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const COMMA = 0x2c;
const COLON = 0x3a;
const OPEN_OBJECT = 0x7b;
const CLOSE_OBJECT = 0x7d;
const OPEN_ARRAY = 0x5b;
const CLOSE_ARRAY = 0x5d;

/**
 * One pass over text `JSON.parse` already accepted, with an explicit stack (no recursion, so any
 * nesting depth): each object's keys are collected as they are read, and the first one seen twice
 * throws. Linear in the text.
 */
function assertNoDuplicateKeys(text: string): void {
  // One entry per open container: a set of keys for an object, undefined for an array.
  const stack: Array<Set<string> | undefined> = [];
  let expectingKey = false;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === QUOTE) {
      const start = index;
      index += 1;
      while (index < text.length && text.charCodeAt(index) !== QUOTE) {
        index += text.charCodeAt(index) === BACKSLASH ? 2 : 1;
      }
      const keys = stack[stack.length - 1];
      if (expectingKey && keys !== undefined) {
        const key = JSON.parse(text.slice(start, index + 1)) as string;
        if (keys.has(key)) {
          throw new DuplicateJsonKeyError(key);
        }
        keys.add(key);
        expectingKey = false;
      }
    } else if (code === OPEN_OBJECT) {
      stack.push(new Set());
      expectingKey = true;
    } else if (code === OPEN_ARRAY) {
      stack.push(undefined);
      expectingKey = false;
    } else if (code === CLOSE_OBJECT || code === CLOSE_ARRAY) {
      stack.pop();
      expectingKey = false;
    } else if (code === COMMA) {
      expectingKey = stack[stack.length - 1] !== undefined;
    } else if (code === COLON) {
      expectingKey = false;
    }
  }
}
