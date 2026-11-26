/**
 * What QuickJS lacks and the byte libraries reach for — measured by `scripts/probe-quickjs-globals.mjs`,
 * not guessed. Installed only where missing, so the same program runs unchanged in-process
 * (where the platform's own implementations stay in place) and in the sandbox.
 *
 * `setTimeout` is a microtask: pdf-lib's `save()` yields through it between object batches
 * (never, with `objectsPerTick: Infinity`, but the reference must resolve), and nothing here
 * needs real time. A timer that waited would never fire — the sandbox has no event loop —
 * so the shim runs the callback on the next microtask, which the host's job drain services.
 */
export function installPdfProgramPolyfills(scope: Record<string, unknown> = globalThis as unknown as Record<string, unknown>): void {
  if (typeof scope.TextEncoder === "undefined") {
    scope.TextEncoder = class PortableTextEncoder {
      public readonly encoding = "utf-8";
      public encode(input = ""): Uint8Array {
        const text = String(input);
        const out: number[] = [];
        for (let i = 0; i < text.length; i += 1) {
          let code = text.charCodeAt(i);
          if (code >= 0xd800 && code < 0xdc00 && i + 1 < text.length) {
            const low = text.charCodeAt(i + 1);
            if (low >= 0xdc00 && low < 0xe000) {
              code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
              i += 1;
            }
          }
          if (code < 0x80) {
            out.push(code);
          } else if (code < 0x800) {
            out.push(0xc0 | (code >> 6), 0x80 | (code & 63));
          } else if (code < 0x10000) {
            out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
          } else {
            out.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 63), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
          }
        }
        return new Uint8Array(out);
      }
    };
  }
  if (typeof scope.TextDecoder === "undefined") {
    // fontkit reads a font's name table as UTF-16BE and a few tables as Latin-1, so the label
    // matters: a decoder that treated everything as UTF-8 would name fonts with NULs in them.
    scope.TextDecoder = class PortableTextDecoder {
      public readonly encoding: string;
      constructor(label = "utf-8") {
        this.encoding = String(label).toLowerCase().replace(/_/g, "-");
      }
      public decode(input?: ArrayBufferView | ArrayBuffer): string {
        if (!input) {
          return "";
        }
        const bytes = input instanceof Uint8Array ? input : ArrayBuffer.isView(input) ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength) : new Uint8Array(input);
        const encoding = this.encoding;
        if (encoding === "utf-16be" || encoding === "utf-16le" || encoding === "utf-16" || encoding === "ucs-2") {
          const little = encoding === "utf-16le";
          let out = "";
          for (let i = 0; i + 1 < bytes.length; i += 2) {
            out += String.fromCharCode(little ? bytes[i]! | (bytes[i + 1]! << 8) : (bytes[i]! << 8) | bytes[i + 1]!);
          }
          return out;
        }
        if (encoding === "latin1" || encoding === "iso-8859-1" || encoding === "ascii" || encoding === "us-ascii" || encoding === "windows-1252" || encoding === "macintosh" || encoding === "x-mac-roman") {
          let out = "";
          for (let i = 0; i < bytes.length; i += 1) {
            out += String.fromCharCode(bytes[i]!);
          }
          return out;
        }
        let out = "";
        for (let i = 0; i < bytes.length; ) {
          const b = bytes[i++]!;
          if (b < 0x80) {
            out += String.fromCharCode(b);
          } else if (b < 0xe0) {
            out += String.fromCharCode(((b & 31) << 6) | (bytes[i++]! & 63));
          } else if (b < 0xf0) {
            out += String.fromCharCode(((b & 15) << 12) | ((bytes[i++]! & 63) << 6) | (bytes[i++]! & 63));
          } else {
            const codePoint = ((b & 7) << 18) | ((bytes[i++]! & 63) << 12) | ((bytes[i++]! & 63) << 6) | (bytes[i++]! & 63);
            out += String.fromCodePoint(codePoint);
          }
        }
        return out;
      }
    };
  }
  // unicode-properties (fontkit's character data) decodes its base64 trie with `atob` while its
  // module loads. The result is a binary string, one character per byte.
  if (typeof scope.atob === "undefined") {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    scope.atob = (input: string): string => {
      const clean = String(input).replace(/[\t\n\f\r =]/g, "");
      let out = "";
      let buffer = 0;
      let bits = 0;
      for (let i = 0; i < clean.length; i += 1) {
        const value = alphabet.indexOf(clean[i]!);
        if (value < 0) {
          throw new Error("atob: the string is not correctly encoded");
        }
        buffer = (buffer << 6) | value;
        bits += 6;
        if (bits >= 8) {
          bits -= 8;
          out += String.fromCharCode((buffer >> bits) & 0xff);
          buffer &= (1 << bits) - 1;
        }
      }
      return out;
    };
  }
  if (typeof scope.setTimeout === "undefined") {
    scope.setTimeout = (callback: (...args: unknown[]) => void, _delay?: number, ...args: unknown[]): number => {
      Promise.resolve().then(() => callback(...args));
      return 0;
    };
    scope.clearTimeout = (): void => undefined;
  }
  // pdf-lib reports through `console.warn` (the XFA it strips from a template, an object it
  // cannot parse) and the sandbox has no console: without one a warning nobody can read would
  // surface as a ReferenceError and fail the request. What matters is in the kernel's own
  // `warnings` (`template.xfa_removed`), so the stand-in says nothing.
  if (typeof scope.console === "undefined") {
    const silent = (): void => undefined;
    scope.console = { log: silent, info: silent, warn: silent, error: silent, debug: silent, trace: silent };
  }
  // The sandbox disables the clock for determinism. pdf-lib's PNG decoder reads `Date.now()`
  // purely to time itself, so where the clock throws, it becomes one that never moves — still
  // no source of variation, and images embed the same way inside the sandbox as outside.
  const clock = scope.Date as { now?: () => number } | undefined;
  if (clock && typeof clock.now === "function") {
    try {
      clock.now();
    } catch {
      clock.now = () => 0;
    }
  }
}
