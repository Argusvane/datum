/**
 * The text group of the formula function library.
 *
 * Kernel-shaped like the evaluator: the sandbox program splices these
 * functions' source in beside the portable kernel, so the file holds top-level `function`
 * declarations only, named with the kernel's prefix, referencing only other spliced functions
 * and standard globals; no module constants, no closures, no `Date`, no `Intl`, no
 * `Math.random`. Regex literals inside a body are fine. Every function is listed in
 * {@link TEXT_FUNCTIONS}, which `PORTABLE_KERNEL_FUNCTIONS` spreads.
 *
 * `kernelExprCall` (evaluator.ts) asks {@link kernelTextHandles} before calling
 * {@link kernelTextCall}; the two stay parallel so neither needs a sentinel. The rows of
 * `FORMULA_FUNCTION_TABLE` this group evaluates: titleCase, trim, startsWith, endsWith,
 * substring, indexOf (over a text or a list), replace, split, join, matches, text, padStart.
 * (concat, len, lower, upper and contains stay in the evaluator.) A text over 10,000 characters
 * is read by its first 10,000 (one `text.truncated` warning per call) by every function that
 * reads a whole text: here and in lower, upper and contains in the evaluator (`len` counts the
 * whole text). Unknown-typed input yields
 * `undefined`, never a throw. Positions and lengths count code points, so an emoji is one
 * character and a surrogate pair is never cut in two. Size guards keep a hostile answer from
 * exhausting memory: a text output over 10,000 characters (join, replace, concat) is cut to its
 * first 10,000 with the same warning, `padStart` clamps its length to 10,000, and `matches`
 * refuses a pattern over 256 characters (`undefined`). Each trip is said to the optional `warn`
 * the evaluator passes (one line naming the function and the cap). A pathological pattern
 * inside those limits is still bounded only by the sandbox's evaluation epoch. On the server's
 * kernel a pattern of a catastrophic shape (`kernelRegexRisky`) is refused here too, whatever
 * built it, when the run's `regexCache` says `refuseRisky`.
 */
import { kernelRegexRisky } from "../../core/expressions/compile.js";

/** Whether `name` is a function this group evaluates. */
export function kernelTextHandles(name: string): boolean {
  switch (name) {
    case "titleCase":
    case "trim":
    case "startsWith":
    case "endsWith":
    case "substring":
    case "indexOf":
    case "replace":
    case "split":
    case "join":
    case "matches":
    case "text":
    case "padStart":
      return true;
    default:
      return false;
  }
}

/** A text argument: a string as is, a finite number or boolean through `String`, else `undefined`. */
export function kernelTextArg(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "boolean" || (typeof value === "number" && isFinite(value))) {
    return String(value);
  }
  return undefined;
}

/** How many code points `text` holds: a surrogate pair counts once. */
export function kernelTextLength(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i += 1;
      }
    }
    count += 1;
  }
  return count;
}

/** Whether the code-unit offset `at` falls between the halves of a surrogate pair. */
function kernelTextSplitsPair(text: string, at: number): boolean {
  if (at <= 0 || at >= text.length) {
    return false;
  }
  const before = text.charCodeAt(at - 1);
  const after = text.charCodeAt(at);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

/** A whole-number argument (truncated), or `undefined`. */
function kernelTextInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !isFinite(value)) {
    return undefined;
  }
  return Math.trunc(value);
}

/** Says a size cap tripped to `warn` (when there is one) and gives the no answer the caller returns. */
function kernelTextTripped(warn: ((message: string) => void) | undefined, name: string, cap: string): undefined {
  if (typeof warn === "function") {
    warn(name + ": " + cap + "; no answer");
  }
  return undefined;
}

/**
 * Whether `text` is over the 10,000 character cap, said to `warn` when it is (the caller then
 * reads {@link kernelTextHead} instead). Every text function that reads a whole text works on at
 * most that much, so a filler's long answer never reaches a native string call whole (it is read by its head, not refused).
 */
export function kernelTextOverCap(text: string, warn: ((message: string) => void) | undefined, name: string): boolean {
  if (text.length > 10000) {
    if (typeof warn === "function") {
      warn(name + ": the text is over the 10,000 character cap; its first 10,000 characters were used (text.truncated)");
    }
    return true;
  }
  return false;
}

/** The first 10,000 characters of `text`, never ending on half a surrogate pair. */
export function kernelTextHead(text: string): string {
  const cut = text.slice(0, 10000);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, cut.length - 1) : cut;
}

/** `text` as the functions read it: whole when short, else its head, said to `warn`. */
function kernelTextCapped(text: string, warn: ((message: string) => void) | undefined, name: string): string {
  return kernelTextOverCap(text, warn, name) ? kernelTextHead(text) : text;
}

/**
 * The anchored whole-text pattern for `other` when it compiles, else `null`: the pattern alone
 * first, because one that does not compile (an unbalanced bracket, a stray close parenthesis)
 * is no answer and the anchors can hide it (`a)|(b` is a valid body inside `^(?:...)$`). With a
 * `regexCache` (a plain object the host makes once per runtime or run) each pattern compiles
 * once: keys carry a `p:` prefix so a pattern named `__proto__` is only a key, and the cache
 * stops growing at 256 patterns (a pattern computed from answers cannot grow it without bound;
 * past it, a pattern compiles every time as it does with no cache). A compiled `RegExp` here is
 * neither global nor sticky, so reusing one carries no state between calls.
 */
function kernelTextAnchored(other: string, regexCache?: Record<string, unknown>): RegExp | null {
  if (regexCache !== undefined && regexCache !== null && typeof regexCache === "object") {
    const key = "p:" + other;
    if (Object.prototype.hasOwnProperty.call(regexCache, key)) {
      return regexCache[key] as RegExp | null;
    }
    const compiled = kernelTextCompile(other);
    const size = Object.prototype.hasOwnProperty.call(regexCache, "size") ? (regexCache.size as number) : 0;
    if (size < 256) {
      regexCache[key] = compiled;
      regexCache.size = size + 1;
    }
    return compiled;
  }
  return kernelTextCompile(other);
}

/**
 * Whether `other` is of a catastrophic shape ({@link kernelRegexRisky}), asked once per pattern
 * for the life of `regexCache` (the analysis is not free in the sandbox).
 */
function kernelTextRisky(other: string, regexCache: Record<string, unknown>): boolean {
  const key = "r:" + other;
  if (Object.prototype.hasOwnProperty.call(regexCache, key)) {
    return regexCache[key] === true;
  }
  const risky = kernelRegexRisky(other);
  const size = Object.prototype.hasOwnProperty.call(regexCache, "size") ? (regexCache.size as number) : 0;
  if (size < 256) {
    regexCache[key] = risky;
    regexCache.size = size + 1;
  }
  return risky;
}

/** The anchored pattern for `other`, or `null` when `other` is no pattern. */
function kernelTextCompile(other: string): RegExp | null {
  try {
    new RegExp(other, "u");
    return new RegExp("^(?:" + other + ")$", "u");
  } catch (error) {
    return null;
  }
}

/**
 * Evaluates `name` over `args`; `undefined` for a name this group does not handle or an input
 * of the wrong type. `substring` and `indexOf` count from 1 like FEEL; `indexOf` is 0 when the
 * needle is absent. `matches` anchors the pattern to the whole text; a pattern that does not
 * compile gives `undefined`.
 */
export function kernelTextCall(
  name: string,
  args: unknown[],
  warn?: (message: string) => void,
  regexCache?: Record<string, unknown>
): unknown {
  const a = args[0];
  const b = args[1];
  if (name === "text") {
    const whole = kernelTextArg(a);
    return whole === undefined ? undefined : kernelTextCapped(whole, warn, name);
  }
  if (name === "join") {
    if (!Array.isArray(a)) {
      return undefined;
    }
    const sep = b === undefined ? "," : kernelTextArg(b);
    if (sep === undefined) {
      return undefined;
    }
    const parts: string[] = [];
    for (const item of a) {
      const piece = kernelTextArg(item);
      if (piece !== undefined) {
        parts.push(piece);
      }
    }
    return kernelTextCapped(parts.join(sep), warn, name);
  }
  if (name === "indexOf" && Array.isArray(a)) {
    return a.indexOf(b) + 1;
  }
  const whole = kernelTextArg(a);
  if (whole === undefined) {
    return undefined;
  }
  const text = kernelTextCapped(whole, warn, name);
  switch (name) {
    case "titleCase":
      return text.toLowerCase().replace(/(^|[^\p{L}\p{N}'])(\p{L})/gu, (m: string, pre: string, ch: string) => pre + ch.toUpperCase());
    case "trim":
      return text.trim();
    case "startsWith":
    case "endsWith":
    case "indexOf":
    case "split":
    case "matches": {
      const other = kernelTextArg(b);
      if (other === undefined) {
        return undefined;
      }
      if (name === "startsWith") {
        return text.startsWith(other);
      }
      if (name === "endsWith") {
        return text.endsWith(other);
      }
      if (name === "indexOf") {
        // A match that starts or ends inside a surrogate pair is not one; the position is in code points.
        let at = text.indexOf(other);
        while (at >= 0 && (kernelTextSplitsPair(text, at) || kernelTextSplitsPair(text, at + other.length))) {
          at = text.indexOf(other, at + 1);
        }
        return at < 0 ? 0 : kernelTextLength(text.slice(0, at)) + 1;
      }
      if (name === "split") {
        return other === "" ? Array.from(text) : text.split(other);
      }
      if (other.length > 256) {
        return kernelTextTripped(warn, name, "the pattern is over the 256 character cap");
      }
      // A pattern built at run time (`concat(...)`, an answer) was never seen by the compile's
      // check: the server's kernel marks its cache to refuse one of a catastrophic shape here
      // too.
      if (
        regexCache !== undefined &&
        regexCache !== null &&
        typeof regexCache === "object" &&
        Object.prototype.hasOwnProperty.call(regexCache, "refuseRisky") &&
        regexCache.refuseRisky === true &&
        kernelTextRisky(other, regexCache)
      ) {
        return kernelTextTripped(warn, name, "the pattern repeats a repeat and can take very long");
      }
      // Then the whole text must be the match: from index 0, and all of it.
      const anchored = kernelTextAnchored(other, regexCache);
      if (anchored === null) {
        return undefined;
      }
      try {
        const found = anchored.exec(text);
        return found !== null && found.index === 0 && found[0].length === text.length;
      } catch (error) {
        return undefined;
      }
    }
    case "substring": {
      const start = kernelTextInt(b);
      if (start === undefined) {
        return undefined;
      }
      const from = start < 1 ? 0 : start - 1;
      let length: number | undefined;
      if (args[2] !== undefined) {
        length = kernelTextInt(args[2]);
        if (length === undefined) {
          return undefined;
        }
        if (length <= 0) {
          return "";
        }
      }
      // By code point: a text with a surrogate pair is cut on characters, never inside one.
      if (/[\ud800-\udfff]/.test(text)) {
        const characters = Array.from(text);
        return (length === undefined ? characters.slice(from) : characters.slice(from, from + length)).join("");
      }
      return length === undefined ? text.substring(from) : text.substring(from, from + length);
    }
    case "replace": {
      const findWhole = kernelTextArg(b);
      const usingWhole = kernelTextArg(args[2]);
      if (findWhole === undefined || usingWhole === undefined) {
        return undefined;
      }
      const find = kernelTextCapped(findWhole, warn, name);
      const using = kernelTextCapped(usingWhole, warn, name);
      if (find === "") {
        return text;
      }
      // Built piece by piece and stopped at the cap: a long replacement repeated at every match
      // is never made whole.
      const pieces = text.split(find);
      let built = pieces[0] as string;
      for (let i = 1; i < pieces.length && built.length <= 10000; i += 1) {
        built += using + (pieces[i] as string);
      }
      return kernelTextCapped(built, warn, name);
    }
    case "padStart": {
      const length = kernelTextInt(b);
      const fill = args[2] === undefined ? " " : kernelTextArg(args[2]);
      if (length === undefined || fill === undefined) {
        return undefined;
      }
      let target = length;
      if (target > 10000) {
        if (typeof warn === "function") {
          warn(name + ": the length is clamped to the 10,000 character cap (text.truncated)");
        }
        target = 10000;
      }
      // By code point, as length() and substring() count: the fill repeats whole characters and
      // is cut between them, so a surrogate pair is never split into a lone half.
      if (!/[\ud800-\udfff]/.test(text) && !/[\ud800-\udfff]/.test(fill)) {
        return text.padStart(target, fill);
      }
      const have = kernelTextLength(text);
      const characters = Array.from(fill);
      if (target <= have || characters.length === 0) {
        return text;
      }
      let pad = "";
      for (let i = 0; i < target - have; i += 1) {
        pad += characters[i % characters.length] as string;
      }
      return pad + text;
    }
    default:
      return undefined;
  }
}

/** This group's functions, for the kernel's `PORTABLE_KERNEL_FUNCTIONS`. */
export const TEXT_FUNCTIONS: readonly ((...args: never[]) => unknown)[] = [
  kernelTextHandles,
  kernelTextArg,
  kernelTextLength,
  kernelTextSplitsPair,
  kernelTextInt,
  kernelTextTripped,
  kernelTextOverCap,
  kernelTextHead,
  kernelTextCapped,
  kernelTextAnchored,
  kernelTextRisky,
  kernelTextCompile,
  kernelTextCall
];
