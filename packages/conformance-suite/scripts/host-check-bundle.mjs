// The esbuild settings of dist/host-check.mjs (datum-host-check), shared by scripts/build-cli.mjs and
// the kit's own bundle test (tests/host-check/bundle.test.ts builds into a temporary folder, so it never
// races the package build over dist/). Same bundling as the security suite's dist/index.mjs: plain ESM
// for Node 22, no minify (readable stack traces in a CI log), no node_modules at run time.
//
// The kit's fixture files are imported as text with a `?raw` suffix (Vite's spelling, which vitest
// reads natively); the plugin below gives esbuild the same reading, so `datum-host-check fixtures`
// writes the files' very bytes.
import { readFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

export const HOST_CHECK_ENTRY = "src/host-check/main.ts";

/** The bundle stays small: it carries no engine and no QuickJS (run B may add the kernel's DER and the WebAuthn code). */
export const HOST_CHECK_SIZE_BUDGET_BYTES = 1_000_000;

// The text module's name in the bundle is the file's path relative to the package, never the absolute path
// esbuild would otherwise print in the `// raw-text:<path>` comment above each module: a published
// bundle must not carry the folder it was built in.
function rawText(root) {
  return {
    name: "raw-text",
    setup(build) {
      build.onResolve({ filter: /\?raw$/ }, (args) => ({ path: relative(root, resolve(dirname(args.importer), args.path.slice(0, -"?raw".length))).split(sep).join("/"), namespace: "raw-text" }));
      build.onLoad({ filter: /.*/, namespace: "raw-text" }, async (args) => ({ contents: await readFile(resolve(root, args.path), "utf8"), loader: "text" }));
    }
  };
}

/** esbuild options for one bundle of the command at `outfile` (absolute, or relative to `root`). */
export function hostCheckBuildOptions(root, outfile) {
  return {
    absWorkingDir: root,
    entryPoints: [HOST_CHECK_ENTRY],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    minify: false,
    keepNames: false,
    plugins: [rawText(root)],
    logLevel: "warning",
    banner: { js: "import { createRequire as __datumCreateRequire } from 'node:module'; const require = __datumCreateRequire(import.meta.url);" }
  };
}
