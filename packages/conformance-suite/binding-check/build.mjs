// The modules one run of the tester serves, under /binding-check/run/<run>/:
//  - host.js, the host module (host/entry.ts: the engine renderer, its runtime and Datum's binding), one
//    self-contained file. The package carries it prebuilt (dist/host.js, `npm run build:binding-check`);
//    in a checkout of the repository, where host/entry.ts sits beside this file, it is built from the
//    engine's source once per process instead, so a run always holds the engine as it is.
//  - binding.js and the extra entries (a package's print and PDF theme modules, a probe), bundled with
//    esbuild in one build of their own, apart from the host, as a binding ships apart from the page it is
//    drawn on. Datum's own binding (datum/binding.mjs) is served as written and needs no esbuild.
//  - print-theme.js, for Datum's own binding only: its print theme (datumPrintTheme), re-exported from the host module.
// Nothing is written to disk; the files go to the tester's server.
//   const { files, hostUrl, bindingUrl } = await buildRun({ binding: "<path>", name: "gcds" });
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { RUN_PREFIX } from "./server.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const JS = "text/javascript; charset=utf-8";

/** A missing tool or file the run needs: the command exits 3 (preflight) with the message. */
export class PreflightError extends Error {}

/** The host module's source: in a checkout of the repository only (the package carries dist/host.js instead). */
export const HOST_SOURCE = join(here, "host", "entry.ts");
/** The prebuilt host module the package carries. */
export const HOST_BUNDLE = join(here, "dist", "host.js");
/** Datum's own binding as a binding module (`--binding datum`). */
export const DATUM_BINDING = join(here, "datum", "binding.mjs");

/** The esbuild settings of the host module, for the package's build and for a checkout's run. */
export function hostBuildOptions(outfile) {
  return {
    entryPoints: [HOST_SOURCE],
    bundle: true,
    format: "esm",
    target: "es2022",
    platform: "browser",
    // One file: its dynamic imports are inlined, so the run serves it with nothing beside it.
    splitting: false,
    minify: false,
    legalComments: "eof",
    logLevel: "warning",
    ...(outfile ? { outfile, write: true } : { outfile: join(here, ".build", "host.js"), write: false })
  };
}

/** esbuild, an optional peer dependency of the suite: what bundles a binding module for the run. */
export function loadEsbuild() {
  try {
    return createRequire(import.meta.url)("esbuild");
  } catch (error) {
    if (error?.code !== "MODULE_NOT_FOUND") throw error;
    throw new PreflightError("datum-binding-check needs esbuild to bundle the binding module under test, an optional peer dependency of @argusvane/datum-conformance-suite: install it beside the suite (npm install --save-dev esbuild). Datum's own binding (--binding datum) runs without it.");
  }
}

let hostModule;

/** The host module's bytes: built from host/entry.ts in a checkout (once per process), else the package's dist/host.js. */
async function loadHost(esbuild) {
  if (existsSync(HOST_SOURCE)) {
    hostModule ??= (async () => {
      const result = await (esbuild ?? loadEsbuild()).build(hostBuildOptions());
      return result.outputFiles[0].contents;
    })();
    try {
      return await hostModule;
    } catch (error) {
      hostModule = undefined;
      throw error;
    }
  }
  if (!existsSync(HOST_BUNDLE)) throw new PreflightError(`datum-binding-check has no host module: ${HOST_BUNDLE} is missing. The published package carries it; in a copy of the source, run npm run build:binding-check in packages/conformance-suite.`);
  return readFileSync(HOST_BUNDLE);
}

let counter = 0;

/**
 * The files of one run. Resolves to `{ files: Map<name, {contents, type}>, run, hostUrl, bindingUrl, urlOf(entry), dispose }`.
 * `extraEntries` ({ name: path }) are bundled with the binding, so they share its copy of whatever engine code they import.
 * `shared: true` builds the host from source in that same build (a checkout only): for a probe whose own module
 * imports the engine's source and must hold the very runtime and renderer the host module holds (the binding kit).
 */
export async function buildRun({ binding, name = "binding", extraEntries = {}, esbuild, shared = false }) {
  const run = `${name}-${process.pid}-${(counter += 1)}`;
  const files = new Map();
  const isDatum = binding === DATUM_BINDING;
  const entries = { ...(shared ? { host: HOST_SOURCE } : {}), ...(isDatum && !shared ? {} : { binding }), ...extraEntries };
  if (shared && !existsSync(HOST_SOURCE)) throw new PreflightError(`a shared build needs the host module's source (${HOST_SOURCE}): it exists only in a checkout of the Datum repository`);
  if (!shared) files.set(`${run}/host.js`, { contents: await loadHost(esbuild), type: JS });
  if (isDatum && !shared) {
    files.set(`${run}/binding.js`, { contents: readFileSync(DATUM_BINDING), type: JS });
    // Datum's own print theme as the print module (PRT): a re-export from the host module, so it is the very theme the renderer prints with.
    files.set(`${run}/print-theme.js`, { contents: Buffer.from('export { datumPrintTheme } from "./host.js";\n'), type: JS });
  }
  if (Object.keys(entries).length > 0) {
    const outdir = join(here, ".build", run);
    const result = await (esbuild ?? loadEsbuild()).build({
      entryPoints: entries,
      outdir,
      bundle: true,
      write: false,
      format: "esm",
      splitting: true,
      target: "es2022",
      platform: "browser",
      logLevel: "warning"
    });
    for (const file of result.outputFiles) files.set(`${run}/${relative(outdir, file.path).split(sep).join("/")}`, { contents: file.contents, type: JS });
  }
  return {
    files,
    run,
    hostUrl: `${RUN_PREFIX}${run}/host.js`,
    bindingUrl: `${RUN_PREFIX}${run}/binding.js`,
    urlOf: (entry) => `${RUN_PREFIX}${run}/${entry}.js`,
    dispose: () => files.clear()
  };
}
