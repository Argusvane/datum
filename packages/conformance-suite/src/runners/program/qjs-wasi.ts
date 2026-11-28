import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * The server hosts' engine, for program mode: quickjs-ng's own WebAssembly build (`qjs-wasi.wasm`), run the
 * way the FastAPI and Spring Boot hosts run it. Each call is one guest run of `qjs --std -I /app/program.js
 * /app/run.js` with the request on stdin behind a fresh nonce, and its answer is read out of the nonce frame
 * on stdout. The run script and the frame are those of `datum_sandbox.protocol` (`_run_script.py`,
 * `_frame.py`) and of the JVM's `RunScript` and `Frame`; the run itself is in `qjs-wasi-host.ts`.
 */

/** A `qjs-wasi.wasm` held to its pin: the bytes were read once and hashed before anything compiles them. */
export interface QjsWasiModule {
  path: string;
  bytes: Uint8Array;
  sha256: string;
  size: number;
}

export class QjsWasiLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QjsWasiLoadError";
  }
}

const SHA256 = /^[0-9a-f]{64}$/;

/**
 * Reads `qjs-wasi.wasm` and holds it to the pin (its sha256, and its size when the pin has one). A file that is not
 * the pinned module is refused before it is compiled: the release gate runs only the engine the hosts ship.
 */
export function loadQjsWasiModule(path: string, pin: { sha256: string; size?: number }): QjsWasiModule {
  const expected = pin.sha256.toLowerCase();
  if (!SHA256.test(expected)) {
    throw new QjsWasiLoadError(`the qjs-wasi.wasm pin must be a sha256 of 64 hex characters, not "${pin.sha256}"`);
  }
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    throw new QjsWasiLoadError(`cannot read qjs-wasi.wasm at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (pin.size !== undefined && bytes.length !== pin.size) {
    throw new QjsWasiLoadError(`${path} is ${bytes.length} bytes; the pinned qjs-wasi.wasm is ${pin.size}`);
  }
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) {
    throw new QjsWasiLoadError(`${path} has sha256 ${actual}; the pinned qjs-wasi.wasm is ${expected}`);
  }
  return { path, bytes, sha256: actual, size: bytes.length };
}

/** The program's and the run script's names inside the run's read-only `/app`. */
export const APP_PROGRAM = "program.js";
export const APP_RUN_SCRIPT = "run.js";

/** The globals the run script removes before any module is evaluated, in the script's order. */
export const REMOVED_GLOBALS = ["std", "os", "print", "console", "performance", "scriptArgs", "bjson"] as const;

/** The guest's arguments: `--std` gives the script `std` (which it removes); `-I` runs the program first. */
export function guestArgv(): string[] {
  return ["qjs", "--std", "-I", `/app/${APP_PROGRAM}`, `/app/${APP_RUN_SCRIPT}`];
}

export type QjsWasiEntry = "run" | "inspect";

export interface RuleModuleSource {
  id: string;
  version: string;
  source: string;
}

/** A module's comment label: ASCII letters, digits, `_`, `.`, `@` and `-` only, so no line of the script can end in it. */
function label(module: RuleModuleSource): string {
  return `${module.id}@${module.version}`.replace(/[^A-Za-z0-9_.@-]/g, "");
}

/**
 * The module's source as an ASCII-only JSON string literal: every character, a lone surrogate included, reaches `eval`
 * unchanged, and U+2028 or U+2029 never end a script line. The parentheses make the source an expression; the line
 * feeds keep a trailing line comment from swallowing the closing one.
 */
function literal(source: string): string {
  return JSON.stringify(`(\n${source}\n)`).replace(/[\u0080-￿]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/**
 * The sandbox `run.js` for these rule modules, registered in the order given, calling `entry`. It reads stdin (the nonce,
 * a line feed, then the input), keeps `std`, `print`, `eval`, the entry point and the registration function in locals,
 * removes the {@link REMOVED_GLOBALS} (failing the run if one stays), evaluates the freeze snippet, prints the started
 * marker, registers each module, calls the entry point and prints the answer between the begin and end markers.
 *
 * `freeze` is the engine's `FREEZE_INTRINSICS_SNIPPET`; `undefined` leaves it out, which only the negative control of
 * the freeze does (a host never runs without it). `startup` calls no entry point and answers `null`: the check that the
 * program loads and every module registers, which the Node host makes when it builds a sandbox.
 */
export function runScript(freeze: string | undefined, modules: readonly RuleModuleSource[], entry: QjsWasiEntry | "startup"): string {
  const freezeLines: string[] = [];
  if (freeze !== undefined) {
    let text = freeze;
    while (text.endsWith("\n") || text.endsWith("\r")) {
      text = text.slice(0, -1);
    }
    if (text.trim() === "") {
      throw new Error("the freeze snippet is empty");
    }
    freezeLines.push(...text.split("\n"));
  }
  const registrations = modules.flatMap((module) => [`  // ${label(module)}`, `  register(evaluate(${literal(module.source)}));`]);
  const lines = [
    "(function (std, print, evaluate) {",
    '  "use strict";',
    "  var raw = std.in.readAsString();",
    "  var nonce = raw.slice(0, 32);",
    '  if (raw.charAt(32) !== "\\n" || !/^[0-9a-f]{32}$/.test(nonce)) { throw new Error("no run nonce"); }',
    "  var input = raw.slice(33);",
    entry === "startup" ? '  var entry = function () { return "null"; };' : `  var entry = globalThis.__datum_${entry};`,
    "  var register = globalThis.__datum_register;",
    '  if (typeof entry !== "function" || typeof register !== "function") { throw new Error("no sandbox program"); }',
    `  [${REMOVED_GLOBALS.map((name) => `"${name}"`).join(", ")}].forEach(function (name) {`,
    "    delete globalThis[name];",
    '    if (name in globalThis) { throw new Error("cannot remove " + name); }',
    "  });",
    ...freezeLines,
    '  var mark = function (kind) { return "@@datum:" + nonce + ":" + kind + "@@"; };',
    '  print(mark("started"));',
    ...registrations,
    "  var answer = entry(input);",
    '  print(mark("begin"));',
    "  print(answer);",
    '  print(mark("end"));',
    "})(std, print, eval);"
  ];
  return `${lines.join("\n")}\n`;
}

/** A fresh run nonce: 16 random bytes as 32 lower-case hex characters. */
export function newNonce(): string {
  return randomBytes(16).toString("hex");
}

export type MarkerKind = "started" | "begin" | "end";

export function marker(nonce: string, kind: MarkerKind): string {
  return `@@datum:${nonce}:${kind}@@`;
}

/** The whitespace allowed around the markers: JSON's (space, tab, line feed, carriage return). */
const FRAME_SPACE = new Set([0x20, 0x09, 0x0a, 0x0d]);

function count(haystack: Buffer, needle: Buffer): { count: number; first: number } {
  let found = 0;
  let first = -1;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) {
    if (first === -1) {
      first = at;
    }
    found += 1;
  }
  return { count: found, first };
}

/**
 * The answer between this run's begin and end markers, trimmed of JSON whitespace, or `undefined` when stdout is
 * anything but exactly one frame of this nonce: the started, begin and end markers once each and in that order, with
 * nothing but JSON whitespace around them (a line a rule module printed, a second frame, a lone marker, a marker inside
 * the answer all refuse the run).
 */
export function framed(stdout: Buffer, nonce: string): Buffer | undefined {
  const marks = { started: Buffer.from(marker(nonce, "started")), begin: Buffer.from(marker(nonce, "begin")), end: Buffer.from(marker(nonce, "end")) };
  let stop = stdout.length;
  while (stop > 0 && FRAME_SPACE.has(stdout[stop - 1] as number)) {
    stop -= 1;
  }
  let at = 0;
  while (at < stop && FRAME_SPACE.has(stdout[at] as number)) {
    at += 1;
  }
  if (!stdout.subarray(at, at + marks.started.length).equals(marks.started)) {
    return undefined;
  }
  const startedAt = at;
  at += marks.started.length;
  while (at < stop && FRAME_SPACE.has(stdout[at] as number)) {
    at += 1;
  }
  if (!stdout.subarray(at, at + marks.begin.length).equals(marks.begin)) {
    return undefined;
  }
  const beginAt = at;
  const answerFrom = at + marks.begin.length;
  const endAt = stop - marks.end.length;
  if (endAt < answerFrom || !stdout.subarray(endAt, stop).equals(marks.end)) {
    return undefined;
  }
  for (const [kind, where] of [["started", startedAt], ["begin", beginAt], ["end", endAt]] as const) {
    const seen = count(stdout, marks[kind]);
    if (seen.count !== 1 || seen.first !== where) {
      return undefined;
    }
  }
  let from = answerFrom;
  let to = endAt;
  while (from < to && FRAME_SPACE.has(stdout[from] as number)) {
    from += 1;
  }
  while (to > from && FRAME_SPACE.has(stdout[to - 1] as number)) {
    to -= 1;
  }
  return stdout.subarray(from, to);
}

/** True when stdout holds this run's begin and end markers once each: the guest answered, and wrote outside the frame too. */
export function hasStrayOutput(stdout: Buffer, nonce: string): boolean {
  return count(stdout, Buffer.from(marker(nonce, "begin"))).count === 1 && count(stdout, Buffer.from(marker(nonce, "end"))).count === 1;
}
