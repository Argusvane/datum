// A probe: can the byte libraries be bundled into one import-free program
// and evaluated inside QuickJS under the validation sandbox's hardening (no Date, no
// Math.random, no timers, no DOM)? Bundles a probe, evaluates it, and prints every global the
// program reached for that QuickJS lacks, so the polyfill list is a measurement rather than a
// guess. Run with `npm run probe:quickjs`; pass a TTF path to also embed and subset a font.
import { build } from "esbuild";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { newQuickJSWASMModuleFromVariant, shouldInterruptAfterDeadline } from "quickjs-emscripten-core";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = join(root, "dist", "probe");
mkdirSync(scratch, { recursive: true });

const fontPath = process.argv[2] ?? join(root, "node_modules", "dejavu-fonts-ttf", "ttf", "DejaVuSans.ttf");
const fontBase64 = readFileSync(fontPath).toString("base64");

const probe = `
import { PDFDocument, StandardFonts } from "@cantoo/pdf-lib";
import * as fontkit from "fontkit";
import bidiFactory from "bidi-js";
import { LineBreaker } from "linebreak";

function base64ToBytes(text) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const clean = text.replace(/[\\s=]+/g, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let buffer = 0, bits = 0, index = 0;
  for (const char of clean) {
    buffer = (buffer << 6) | alphabet.indexOf(char);
    bits += 6;
    if (bits >= 8) { bits -= 8; out[index++] = (buffer >> bits) & 0xff; }
  }
  return out.subarray(0, index);
}

globalThis.__probe = async function (fontData) {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.registerFontkit(fontkit);
  const page = doc.addPage([300, 200]);
  const helvetica = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText("Hello standard", { x: 10, y: 150, font: helvetica, size: 12 });
  let subsetInfo = "none";
  if (fontData) {
    const font = await doc.embedFont(base64ToBytes(fontData), { subset: true, customName: "ProbeFont" });
    page.drawText("Wörld — مرحبا שלום", { x: 10, y: 100, font, size: 12 });
    subsetInfo = String(font.widthOfTextAtSize("Wörld", 12));
  }
  const form = doc.getForm();
  const field = form.createTextField("probe.name");
  field.setText("Ada");
  field.addToPage(page, { x: 10, y: 40, width: 200, height: 20, font: helvetica });
  const bidi = bidiFactory();
  const levels = Array.from(bidi.getEmbeddingLevels("abc אבג", "ltr").levels);
  const breaker = new LineBreaker("Hello world, this is a probe.");
  let breaks = 0;
  while (breaker.nextBreak()) breaks += 1;
  const bytes = await doc.save({ useObjectStreams: false, objectsPerTick: Infinity });
  let head = "";
  for (let i = 0; i < 8; i += 1) head += String.fromCharCode(bytes[i]);
  return JSON.stringify({ size: bytes.length, head, subsetInfo, levels, breaks });
};
`;

writeFileSync(join(scratch, "probe.ts"), probe);
// WOFF2 needs brotli's 700 KB dictionary; the kernel embeds TTF/OTF only, so the decoder is a stub.
writeFileSync(join(scratch, "brotli-stub.js"), 'export function decompress() { throw new Error("WOFF2 fonts are not supported; supply TTF or OTF"); }\nexport default decompress;');

const buildOptions = {
  entryPoints: [join(scratch, "probe.ts")],
  bundle: true,
  write: false,
  format: "iife",
  platform: "neutral",
  target: "es2020",
  mainFields: ["module", "main"],
  conditions: ["import", "default"],
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [
    {
      name: "datum-pdf-probe-resolves",
      setup(pluginBuild) {
        // Every brotli entry point (the package and its `decompress.js`) is the stub.
        pluginBuild.onResolve({ filter: /^brotli(\/.*)?$/ }, () => ({ path: join(scratch, "brotli-stub.js") }));
        // pdf-lib's standard-fonts and upng carry their own pako 1.x; one pako 2 serves all.
        pluginBuild.onResolve({ filter: /^pako$/ }, () => ({ path: join(root, "node_modules", "pako", "dist", "pako.esm.mjs") }));
      }
    }
  ],
  logLevel: "warning",
  metafile: true
};
const result = await build(buildOptions);
const program = result.outputFiles[0].text;
writeFileSync(join(scratch, "probe.program.js"), program);
const minified = await build({ ...buildOptions, minify: true, metafile: false });
console.log(`minified: ${(minified.outputFiles[0].text.length / 1024).toFixed(0)} KB`);
const top = Object.entries(result.metafile.inputs)
  .map(([file, info]) => [file, info.bytes])
  .sort((a, b) => b[1] - a[1])
  .slice(0, 12);
console.log(`bundle: ${(program.length / 1024).toFixed(0)} KB`);
console.log("largest inputs:");
for (const [file, bytes] of top) console.log(`  ${(bytes / 1024).toFixed(0).padStart(6)} KB  ${file}`);
for (const needle of ["require(", "import(", "process.", "Buffer", "TextEncoder", "TextDecoder", "setTimeout", "setImmediate", "btoa", "atob", "crypto", "performance", "window", "document", "self."]) {
  const count = program.split(needle).length - 1;
  if (count > 0) console.log(`  reference "${needle}": ${count}`);
}

const HARDENING = `
"use strict";
(function () {
  Math.random = function () { throw new Error("Math.random is disabled in the sandbox"); };
  var ThrowingDate = function () { throw new Error("Date is disabled in the sandbox"); };
  ThrowingDate.now = function () { throw new Error("Date.now is disabled in the sandbox"); };
  globalThis.Date = ThrowingDate;
})();
`;

const POLYFILLS = `
(function () {
  // What QuickJS lacks and the libraries reach for. Each one here was found by this probe.
  if (typeof globalThis.TextEncoder === "undefined") {
    globalThis.TextEncoder = class { encode(s) { s = String(s); const out = []; for (let i = 0; i < s.length; i++) { let c = s.charCodeAt(i); if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length) { const d = s.charCodeAt(i + 1); if (d >= 0xdc00 && d < 0xe000) { c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00); i++; } } if (c < 0x80) out.push(c); else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63)); else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63)); else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63)); } return new Uint8Array(out); } };
  }
  if (typeof globalThis.TextDecoder === "undefined") {
    globalThis.TextDecoder = class { decode(bytes) { bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes); let s = ""; for (let i = 0; i < bytes.length;) { const b = bytes[i++]; if (b < 0x80) s += String.fromCharCode(b); else if (b < 0xe0) s += String.fromCharCode(((b & 31) << 6) | (bytes[i++] & 63)); else if (b < 0xf0) s += String.fromCharCode(((b & 15) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63)); else { const cp = ((b & 7) << 18) | ((bytes[i++] & 63) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63); s += String.fromCodePoint(cp); } } return s; } };
  }
  if (typeof globalThis.setTimeout === "undefined") {
    globalThis.setTimeout = function (fn) { Promise.resolve().then(function () { fn(); }); return 0; };
    globalThis.clearTimeout = function () {};
  }
})();
`;

const variant = await import("@jitl/quickjs-singlefile-mjs-release-sync");
const quickJs = await newQuickJSWASMModuleFromVariant(variant);
const runtime = quickJs.newRuntime();
runtime.setMemoryLimit(256 * 1024 * 1024);
runtime.setMaxStackSize(1024 * 1024);
const vm = runtime.newContext();

function evaluate(code, label) {
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + 60_000));
  try {
    const res = vm.evalCode(code, label);
    if ("error" in res && res.error) {
      const detail = vm.dump(res.error);
      res.error.dispose();
      throw new Error(`${label}: ${typeof detail === "object" ? JSON.stringify(detail) : String(detail)}`);
    }
    return res.value;
  } finally {
    runtime.removeInterruptHandler();
  }
}

const started = Date.now();
try {
  evaluate(HARDENING, "hardening").dispose();
  evaluate(POLYFILLS, "polyfills").dispose();
  evaluate(program, "probe.program.js").dispose();
  console.log(`program evaluated in ${Date.now() - started} ms`);

  const callStart = Date.now();
  vm.setProp(vm.global, "__fontData", vm.newString(fontBase64));
  const handle = evaluate("__probe(__fontData)", "call");
  const settled = vm.resolvePromise(handle);
  handle.dispose();
  runtime.executePendingJobs();
  const outcome = await settled;
  if ("error" in outcome && outcome.error) {
    const detail = vm.dump(outcome.error);
    outcome.error.dispose();
    throw new Error(`probe rejected: ${detail && detail.name} ${detail && detail.message}\n${detail && detail.stack}`);
  }
  const payload = vm.getString(outcome.value);
  outcome.value.dispose();
  console.log(`probe ran in ${Date.now() - callStart} ms`);
  console.log(`result: ${payload}`);
} catch (error) {
  console.error(String(error && error.message ? error.message : error));
  process.exitCode = 1;
} finally {
  vm.dispose();
  runtime.dispose();
}
