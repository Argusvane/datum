// Bundles the PDF program into one import-free ES2020 file a QuickJS runtime —
// in a browser, in Node, on a JVM — evaluates once: `dist/datum-pdf.program.js`. The same
// resolves: brotli (WOFF2 only) is a stub, and one pako serves pdf-lib,
// its standard fonts and its PNG decoder. Writes a size report beside the program and fails
// the build when the program grows past its budget or keeps a module loader reference.
import { build } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { collectPackages, packageProblems, renderLicenceFile } from "../../datum/scripts/notices-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
mkdirSync(dist, { recursive: true });

// The program's size ceiling: it covers the formula parser, the definition compiler, the function
// table and its four function groups (text, number, list, date), the template-load guard, the
// field.overflow report, the form texts and the attachment-size and template checks.
// program-bundle.test.ts pins the same ceiling.
const SIZE_BUDGET_BYTES = 1_336_000;
const stubPath = join(dist, "brotli-stub.js");
// fontkit imports the named `decompress` from brotli/decompress.js; the stub serves it and a default export alike.
writeFileSync(
  stubPath,
  'export function decompress() { throw new Error("WOFF2 fonts are not supported; supply TTF or OTF"); }\nexport default decompress;\n'
);

// The one base64 decoder pdf-lib, its standard-fonts package and fontkit each carry sizes its
// buffer for the padding, then writes three bytes per quartet regardless, so a padded input
// writes one or two bytes past the end. Every modern engine drops such a write; QuickJS before
// 2023 throws "out-of-bound numeric index" in strict code, and the program is strict. A server
// embedding that QuickJS — the archived Python `quickjs` package did — could not even evaluate
// the program (the standard-fonts package decodes its encodings at load). The three decoders get
// room for the overrun and trim it off; the build fails should a library upgrade move them.
// Since @cantoo/pdf-lib 2.11 the standard-fonts package ships inside pdf-lib (es/packages/standard-fonts).
const DECODER_FILES = /[\\/](?:@cantoo[\\/]pdf-lib[\\/]es[\\/]utils[\\/]base64\.js|@cantoo[\\/]pdf-lib[\\/]es[\\/]packages[\\/]standard-fonts[\\/]utils\.js|fontkit[\\/]dist[\\/]browser[\\/]chunks[\\/][^\\/]+\.js)$/;
const EXPECTED_DECODERS = 3;
let guardedDecoders = 0;

function guardBase64Decoders(source) {
  const allocation = "new Uint8Array(bufferLength)";
  let out = "";
  let cursor = 0;
  for (;;) {
    const at = source.indexOf(allocation, cursor);
    if (at === -1) {
      break;
    }
    const end = source.indexOf("return bytes;", at);
    if (end === -1) {
      throw new Error("build-program: a base64 decoder allocates its buffer but never returns it as expected");
    }
    out += `${source.slice(cursor, at)}new Uint8Array(bufferLength + 2)${source.slice(at + allocation.length, end)}return bytes.slice(0, bufferLength);`;
    cursor = end + "return bytes;".length;
    guardedDecoders += 1;
  }
  return out + source.slice(cursor);
}

/** The named exports of a module as inert stand-ins: constants become their name, functions and classes no-ops. */
function stubExports(source) {
  const names = new Set();
  for (const match of source.matchAll(/^export\s+(?:async\s+)?(?:const|let|var|function\*?|class)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm)) {
    names.add(match[1]);
  }
  for (const match of source.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const entry of match[1].split(",")) {
      const name = entry.split(/\s+as\s+/).pop()?.trim();
      if (name && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) {
        names.add(name);
      }
    }
  }
  return [...names].map((name) => (/^[A-Z][A-Z0-9_]*$/.test(name) ? `export const ${name} = ${JSON.stringify(name)};` : `export function ${name}() {}`)).join("\n") + "\n";
}

const result = await build({
  entryPoints: [join(root, "src", "program", "main.ts")],
  // The polyfills run before any module body: libraries build a TextEncoder at load time.
  inject: [join(root, "src", "program", "polyfills-first.ts")],
  bundle: true,
  write: false,
  format: "iife",
  platform: "neutral",
  target: "es2020",
  minify: true,
  // The third-party legal comments go to a file beside the program, never into it: a QuickJS
  // evaluates the program once per request or per process, and a licence header is text it would parse for nothing.
  legalComments: "external",
  outfile: join(dist, "datum-pdf.program.js"),
  absWorkingDir: root,
  mainFields: ["module", "main"],
  conditions: ["import", "default"],
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [
    {
      name: "datum-pdf-program-resolves",
      setup(pluginBuild) {
        pluginBuild.onResolve({ filter: /^brotli(\/.*)?$/ }, () => ({ path: stubPath }));
        pluginBuild.onResolve({ filter: /^pako$/ }, () => ({ path: join(root, "node_modules", "pako", "dist", "pako.esm.mjs") }));
        // The program is a browser-shaped bundle: Node's own modules never enter it.
        pluginBuild.onResolve({ filter: /^node:/ }, (args) => ({ path: args.path, external: true }));
        // The engine's custom elements never run in the program (a kernel has no DOM), and they
        // must not enter its graph either: the renderer element lazily `import()`s the PDF
        // pipeline, and that one dynamic edge makes esbuild wrap every pdf module in a lazy
        // initializer — then, with the element's own code tree-shaken away, it emits no eager
        // initialization for them at all, and the program answers no ABI. Their re-exports
        // (`export *` in the render barrel) resolve to empty modules here.
        pluginBuild.onResolve({ filter: /[\/]web-component[\/](?:form-renderer-element|form-host-element|locale-select-element)\.js$/ }, (args) => ({
          path: join(args.resolveDir, args.path.replace(/\.js$/, ".ts")),
          namespace: "datum-program-stub"
        }));
        // The same trap from any other lazily loaded engine module: the program has no loader,
        // so a chunk an `import()` names never loads in it anyway. A builder mode that loads its
        // designer on demand (the journey designer, reached through the engine's root barrel)
        // otherwise wraps that designer and everything under it, the component tree included,
        // in lazy initializers, and the program's `build` then calls a class never initialized
        // ("not a function"). Only the dynamic edge is stubbed: a static import of the same
        // module still reaches the real one, which tree shaking then drops.
        pluginBuild.onResolve({ filter: /\.js$/ }, (args) =>
          args.kind === "dynamic-import" && /[\/]engine[\/]form-engine[\/]/.test(args.resolveDir)
            ? { path: join(args.resolveDir, args.path.replace(/\.js$/, ".ts")), namespace: "datum-program-stub" }
            : undefined
        );
        // The stub keeps the module's exported names (the builder imports a few by name), each an
        // inert value, so the graph links and nothing of the element remains.
        pluginBuild.onLoad({ filter: /.*/, namespace: "datum-program-stub" }, (args) => ({ contents: stubExports(readFileSync(args.path, "utf8")), loader: "js" }));
        pluginBuild.onLoad({ filter: DECODER_FILES }, (args) => ({
          contents: guardBase64Decoders(readFileSync(args.path, "utf8")),
          loader: "js"
        }));
      }
    }
  ],
  metafile: true,
  logLevel: "warning"
});

const programFile = result.outputFiles.find((file) => file.path.endsWith(".js"));
const program = programFile.text;
// esbuild writes external legal comments beside the output as <outfile>.LEGAL.txt. Any other text
// output would be dropped unread, so one the build does not consume fails it.
const textOutputs = result.outputFiles.filter((file) => file.path.endsWith(".txt"));
const legalFile = textOutputs.find((file) => file.path.endsWith(".LEGAL.txt"));
const unconsumed = textOutputs.filter((file) => file !== legalFile);
if (unconsumed.length > 0) {
  console.error(`build-program: unconsumed text output: ${unconsumed.map((file) => file.path).join(", ")}`);
  process.exit(1);
}
const legalComments = legalFile?.text ?? "";
const banner = `/* Datum PDF program. Built by @argusvane/datum-pdf-kernel; evaluate once, then call globalThis.__datum_pdf(requestJson). */\n`;
const output = banner + program;
writeFileSync(join(dist, "datum-pdf.program.js"), output);

// The licence text of every package the program carries, from the metafile's account of what is in the
// output (a module the bundler shook out has no bytes there), beside the program as datum-pdf.program.LICENSE.txt.
const carried = Object.values(result.metafile.outputs)
  .flatMap((output) => Object.entries(output.inputs))
  .filter(([, input]) => input.bytesInOutput > 0)
  .map(([file]) => ({ file: resolve(root, file), scope: "core" }));
const packages = collectPackages(carried);
const licenceProblems = packageProblems(packages);
writeFileSync(
  join(dist, "datum-pdf.program.LICENSE.txt"),
  renderLicenceFile({ bundle: "datum-pdf-program", covers: "It covers datum-pdf-program.js, the PDF program a server evaluates in a QuickJS of its own.", packages, legalComments })
);

const inputs = Object.entries(result.metafile.inputs)
  .map(([file, info]) => ({ file, bytes: info.bytes }))
  .sort((a, b) => b.bytes - a.bytes);
const report = {
  bytes: Buffer.byteLength(output),
  budgetBytes: SIZE_BUDGET_BYTES,
  // What the program was made to run on: any QuickJS release from March 2021 on, so a host's binding of
  // the engine need not be current (the base64 decoders guarded above are what that took).
  portability: { base64DecodersGuarded: guardedDecoders },
  largestInputs: inputs.slice(0, 15)
};
writeFileSync(join(dist, "datum-pdf.program.meta.json"), JSON.stringify(report, null, 2));

const problems = [...licenceProblems];
if (report.bytes > SIZE_BUDGET_BYTES) {
  problems.push(`program is ${report.bytes} bytes, over the ${SIZE_BUDGET_BYTES} budget`);
}
if (guardedDecoders !== EXPECTED_DECODERS) {
  problems.push(`guarded ${guardedDecoders} base64 decoder(s), expected ${EXPECTED_DECODERS} (pdf-lib, standard-fonts, fontkit); a library moved its decoder`);
}
if (!output.includes("__datum_pdf")) {
  problems.push("program does not define __datum_pdf");
}
// A dynamic import or a require that survived bundling would fail inside a sandbox with no loader.
for (const needle of [/\bimport\s*\(/, /\brequire\s*\(\s*["']node:/]) {
  if (needle.test(program)) {
    problems.push(`program keeps a module loader reference: ${needle}`);
  }
}
// The program evaluated once in a bare context must install its globals with the ABI it was
// built from: a module esbuild left uninitialized (see the element stub above) shows up here.
try {
  const context = createContext({});
  runInContext(output, context, { filename: "datum-pdf.program.js" });
  const abi = runInContext("globalThis.__datum_pdf_abi", context);
  if (typeof abi !== "string" || abi === "") {
    problems.push(`program installs no ABI version (a module was not initialized): __datum_pdf_abi is ${String(abi)}`);
  } else {
    // A module left uninitialized can sit under code the globals never touch, and fail only
    // the first request that reaches it: build one small form's document to find out here.
    const form = { id: "f", type: "form", configuration: {}, children: { content: [{ id: "name", type: "text", configuration: {} }] } };
    const call = runInContext("globalThis.__datum_pdf", context);
    const reply = JSON.parse(await call(JSON.stringify({ abi, op: "build", form, values: { name: "Ada" }, locale: "en" })));
    if (reply.ok !== true) {
      problems.push(`program cannot build a document (a module was not initialized?): ${reply.error?.message ?? "no reply"}`);
    }
  }
} catch (error) {
  problems.push(`program throws when evaluated: ${error instanceof Error ? error.message : String(error)}`);
}
if (problems.length > 0) {
  console.error(`build-program: ${problems.join("; ")}`);
  process.exit(1);
}
console.log(`build-program: dist/datum-pdf.program.js (${(report.bytes / 1024).toFixed(0)} KB)`);
