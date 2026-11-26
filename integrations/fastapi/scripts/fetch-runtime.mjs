#!/usr/bin/env node
// Fetches qjs-wasi.wasm from the official quickjs-ng release the pin names and verifies its size and sha256 against the pin
// (datum_qjs_wasm/runtime.json, written by integrations/shared/scripts/pin-runtime.mjs --target fastapi). build-assets.mjs calls
// fetchRuntime(); the command line is the same step on its own.
//
//   node integrations/fastapi/scripts/fetch-runtime.mjs [--qjs-wasm-file <path>] [--out <path>]
//
// --qjs-wasm-file takes the file from disk instead of the network (an air-gapped build); it is held to the same pin. A file that
// fails the check is never written. Only the official quickjs-ng repository is read.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = join(here, "..", "packages", "argusvane-datum-qjs-wasm", "src", "datum_qjs_wasm");

export const PIN_PATH = join(PACKAGE_DIR, "runtime.json");
export const WASM_PATH = join(PACKAGE_DIR, "qjs-wasi.wasm");
export const OFFICIAL_RELEASE_PREFIX = "https://github.com/quickjs-ng/quickjs/releases/download/";

const sha256Of = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** The pin, read from runtime.json; throws with the repair command when it is missing or incomplete. */
export const loadPin = (path = PIN_PATH) => {
  if (!existsSync(path)) {
    throw new Error(`fetch-runtime: ${path} is missing — run \`npm run fastapi:pin-runtime -- v0.16.2\`.`);
  }
  const pin = JSON.parse(readFileSync(path, "utf8"));
  for (const key of ["asset", "url", "sha256", "size"]) {
    if (pin[key] === undefined) {
      throw new Error(`fetch-runtime: ${path} has no "${key}".`);
    }
  }
  return pin;
};

/** Throws unless the bytes have the pinned size and sha256. */
export const verifyRuntimeBytes = (bytes, pin) => {
  if (bytes.length !== pin.size) {
    throw new Error(`fetch-runtime: qjs-wasi.wasm has size ${bytes.length}, the pin says ${pin.size}.`);
  }
  const actual = sha256Of(bytes);
  if (actual !== pin.sha256) {
    throw new Error(`fetch-runtime: qjs-wasi.wasm has sha256 ${actual}, the pin says ${pin.sha256}.`);
  }
};

/**
 * Puts the verified qjs-wasi.wasm at `out` and returns its path. Order: `file` (--qjs-wasm-file) when given; else a copy already
 * at `out` that passes the pin; else the pin's URL (official quickjs-ng release only, abandoned after `timeoutMs`). The write is atomic.
 */
export const DEFAULT_TIMEOUT_MS = 120_000;

export const fetchRuntime = async ({ pin = loadPin(), out = WASM_PATH, file, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) => {
  if (!pin.url.startsWith(OFFICIAL_RELEASE_PREFIX)) {
    throw new Error(`fetch-runtime: the pin's URL ${pin.url} is not under ${OFFICIAL_RELEASE_PREFIX} (only the official quickjs-ng release is read).`);
  }
  let bytes;
  if (file !== undefined) {
    bytes = readFileSync(file);
  } else {
    if (existsSync(out)) {
      try {
        verifyRuntimeBytes(readFileSync(out), pin);
        return out;
      } catch {
        // Stale or damaged: fetched again below.
      }
    }
    // One signal covers the request and the body: a stalled download ends with a named error, never a hung build.
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      const response = await fetch(pin.url, { headers: { "user-agent": "datum-fetch-runtime" }, signal });
      if (!response.ok) {
        throw new Error(`fetch-runtime: ${pin.url}: HTTP ${response.status}`);
      }
      bytes = Buffer.from(await response.arrayBuffer());
    } catch (error) {
      if (signal.aborted) {
        throw new Error(`fetch-runtime: ${pin.url} timed out after ${timeoutMs} ms.`);
      }
      throw error;
    }
  }
  verifyRuntimeBytes(bytes, pin);
  mkdirSync(dirname(out), { recursive: true });
  const partial = `${out}.partial`;
  writeFileSync(partial, bytes);
  try {
    renameSync(partial, out);
  } catch (error) {
    rmSync(partial, { force: true });
    throw error;
  }
  return out;
};

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const argv = process.argv.slice(2);
  const valueOf = (name) => {
    const at = argv.findIndex((arg) => arg === name || arg.startsWith(`${name}=`));
    if (at < 0) {
      return undefined;
    }
    return argv[at].includes("=") ? argv[at].slice(name.length + 1) : argv[at + 1];
  };
  try {
    const path = await fetchRuntime({ file: valueOf("--qjs-wasm-file"), out: valueOf("--out") ?? WASM_PATH });
    console.log(`fetch-runtime: ${path} verified against the pin`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
