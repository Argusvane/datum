// The esbuild settings of datum-form-test's bundles, shared by
// scripts/build-cli.mjs and tests/bundle.test.ts (which builds into a temporary folder, so it never
// races the package build over dist/). The conformance suite's settings, for its reasons:
//  - no minify, no keepNames: the bundle must not inject `__name` helpers into functions the sandbox
//    program splices as source (`buildSandboxProgram` reads Function.prototype.toString); the command
//    takes --program <file> and never builds one, but a caller of the API might.
//  - ignoreAnnotations: the engine says "sideEffects": false, and esbuild would then drop the lazy
//    `init_*()` calls of the engine's import cycles.
//  - a createRequire banner for the few CommonJS `require` calls in the QuickJS loader.
//  - the worker host's thread body is a file beside its package, which a single-file bundle cannot carry.

/** dist/index.mjs: the engine root, the Logic model and QuickJS's inlined WASM (3,176,222 bytes, see build-cli.mjs). */
export const INDEX_BUDGET_BYTES = 4_000_000;
/** dist/vitest.mjs: the helper alone; everything else it reads comes from ./index.mjs. */
export const VITEST_BUDGET_BYTES = 100_000;

const BANNER = "import { createRequire as __datumCreateRequire } from 'node:module'; const require = __datumCreateRequire(import.meta.url);";

const common = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  minify: false,
  keepNames: false,
  ignoreAnnotations: true,
  logLevel: "warning"
};

/** dist/index.mjs (or `outfile`): the package's whole programmatic surface and the command. */
export function indexBuildOptions(root, outfile) {
  return {
    ...common,
    absWorkingDir: root,
    entryPoints: ["src/index.ts"],
    outfile,
    external: ["@argusvane/datum-quickjs-wasm-host/worker"],
    banner: { js: BANNER },
    metafile: true
  };
}

/**
 * Every module of the package and of the engine the helper imports is taken from ./index.mjs at run
 * time, so the helper carries the engine once (in index.mjs) and its bundle stays small. The helper
 * may import its neighbours by their own paths (./run.js, ./report/words.js, ...): each name it
 * imports must then be one src/index.ts exports, which tests/bundle.test.ts checks.
 */
const helperImportsFromIndex = {
  name: "helper-imports-from-index",
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) => {
      const fromHelper = /[\\/]src[\\/]vitest\.ts$/.test(args.importer);
      if (fromHelper && (args.path.startsWith(".") || args.path.startsWith("@argusvane/"))) {
        return { path: "./index.mjs", external: true };
      }
      return undefined;
    });
  }
};

/** dist/vitest.mjs (or `outfile`): the vitest helper, with `vitest` and ./index.mjs external. */
export function vitestBuildOptions(root, outfile) {
  return {
    ...common,
    absWorkingDir: root,
    entryPoints: ["src/vitest.ts"],
    outfile,
    external: ["vitest"],
    plugins: [helperImportsFromIndex],
    metafile: true
  };
}

/** dist/cli.mjs: the three-line entry over ./index.mjs. */
export const CLI_ENTRY = [
  "// The command line: dist/index.mjs holds the tool (scripts/build-cli.mjs).",
  'import { runCli } from "./index.mjs";',
  "process.exitCode = await runCli(process.argv.slice(2));",
  ""
].join("\n");
