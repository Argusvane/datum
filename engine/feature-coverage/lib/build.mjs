// Bundles the host page's module (host/entry.ts) from engine source with esbuild, in memory: the
// renderer, the Datum binding, the runtime and the corpus fixtures, one copy of lit. Nothing is
// written to disk; the server serves the output files by name.
//
// `engineRoot` swaps engine/form-engine for another copy of it (a scratch copy with a regression
// injected, to prove the harness fails): every import that resolves into engine/form-engine is
// sent to the same path under `engineRoot`, the fixtures and the host module included.
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const harnessRoot = join(here, "..");
export const engineDir = join(harnessRoot, "..");
const formEngine = join(engineDir, "form-engine");
const esbuild = createRequire(join(engineDir, "package.json"))("esbuild");

function engineRootPlugin(to) {
  const target = resolve(to);
  return {
    name: "engine-root",
    setup(build) {
      build.onResolve({ filter: /.*/ }, async (args) => {
        if (args.pluginData?.engineRoot || args.kind === "entry-point") return undefined;
        const found = await build.resolve(args.path, { kind: args.kind, resolveDir: args.resolveDir, importer: args.importer, pluginData: { engineRoot: true } });
        if (found.errors.length > 0 || found.external) return found;
        if (found.path === formEngine || found.path.startsWith(formEngine + sep)) {
          return { path: join(target, relative(formEngine, found.path)), sideEffects: false };
        }
        return { path: found.path, ...(found.sideEffects === false ? { sideEffects: false } : {}) };
      });
    }
  };
}

/** Builds the bundle; resolves to `{ files: Map<name, {contents, type}>, ms }`. */
export async function buildHost({ engineRoot } = {}) {
  const started = Date.now();
  const outdir = join(harnessRoot, ".build");
  const result = await esbuild.build({
    entryPoints: { host: join(harnessRoot, "host", "entry.ts") },
    outdir,
    bundle: true,
    format: "esm",
    splitting: true,
    target: "es2022",
    platform: "browser",
    write: false,
    sourcemap: "inline",
    logLevel: "warning",
    // A scratch copy of form-engine has no node_modules beside it: bare imports (lit-html) come from the engine's.
    nodePaths: [join(engineDir, "node_modules")],
    plugins: engineRoot ? [engineRootPlugin(engineRoot)] : []
  });
  const files = new Map();
  for (const file of result.outputFiles) {
    files.set(relative(outdir, file.path).split(sep).join("/"), { contents: file.contents, type: file.path.endsWith(".map") ? "application/json" : "text/javascript" });
  }
  return { files, ms: Date.now() - started };
}
