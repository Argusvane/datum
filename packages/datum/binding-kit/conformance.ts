// Conformance: what `datum-binding-check` (the conformance suite's command) says of a binding.
// The kit does not carry a second corpus: it runs the suite's own runner on the binding, so a
// binding's CI and the kit agree on what "conforms" means. The kit adds the pinned assets file of
// the package (bindings/<id>/binding-check.json) and the port range.
//
//   node binding-kit/conformance.ts --binding govuk [--report dir] [--only ids] [--browser b] [--baseline report.json]
//
// Exit codes are the suite's: 0 pass, 1 a case failed, 2 usage error or nothing asserted,
// 3 preflight, 4 internal.
import { runBindingCheck } from "@argusvane/datum-conformance-suite/binding-check";
import { BINDINGS_ROOT, resolveBinding } from "./lib/binding-package.mjs";
import { join } from "node:path";
import { pickPort } from "./lib/ports.mjs";

export interface ConformanceOptions {
  /** `datum`, a package id under bindings/, or the path of a binding module. */
  binding: string;
  /** The assets file, for a binding given as a module path. */
  assets?: string;
  only?: readonly string[];
  report?: string;
  baseline?: string;
  browser?: string;
  /** First port to try (default: the first free one of 5200-5219). */
  port?: number;
  continueAfterPreflight?: boolean;
  log?: (line: string) => void;
}

/**
 * What the suite is given for a package the kit resolved: `datum`; a package in `bindings/<id>` by
 * its id; one kept elsewhere (`--binding .`, `--binding ../my-binding`) by its module and its
 * assets file, which the suite reads as a module path and `--assets`.
 */
export function conformanceTarget(pkg: { isDatum: boolean; id: string; dir?: string | undefined; entry?: string | undefined; assetsFile?: string | undefined }): { binding: string; assets?: string } {
  if (pkg.isDatum) return { binding: "datum" };
  if (pkg.dir === join(BINDINGS_ROOT, pkg.id)) return { binding: pkg.id };
  if (pkg.entry === undefined) throw new Error(`${pkg.dir}: no binding module (src/index.ts, or "binding" in binding-check.json)`);
  return { binding: pkg.entry, ...(pkg.assetsFile ? { assets: pkg.assetsFile } : {}) };
}

/** A command line's `--binding` (and `--assets`) as the suite wants them: a module path as it is, anything else resolved as the kit resolves a package (an id, `datum`, or a package folder). */
export function conformanceTargetOf(binding: string, assets?: string): { binding: string; assets?: string } {
  if (/\.(?:[mc]?[jt]s)$/.test(binding)) return { binding, ...(assets ? { assets } : {}) };
  return conformanceTarget(resolveBinding(binding));
}

/** The suite's argument list for these options. */
export function argumentsFor(options: ConformanceOptions, port: number): string[] {
  // Offline, as every kit run is: the suite's browser refuses what the binding's routes and "network" do not answer.
  const args = ["--binding", options.binding, "--port", String(port), "--offline"];
  if (options.assets) args.push("--assets", options.assets);
  if (options.only?.length) args.push("--only", options.only.join(","));
  if (options.report) args.push("--report", options.report);
  if (options.baseline) args.push("--baseline", options.baseline);
  if (options.browser) args.push("--browser", options.browser);
  if (options.continueAfterPreflight) args.push("--continue");
  return args;
}

/** Runs `datum-binding-check` on the binding; resolves to its exit code. */
export async function runConformance(options: ConformanceOptions): Promise<number> {
  const log = options.log ?? ((line: string): void => console.log(line));
  const port = options.port ?? (await pickPort());
  return runBindingCheck(argumentsFor(options, port), { out: log, err: log });
}

function parse(argv: readonly string[]): ConformanceOptions & { help?: boolean } {
  const options: ConformanceOptions & { help?: boolean } = { binding: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = (): string => {
      const value = argv[(i += 1)];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      return value;
    };
    if (arg === "--binding") options.binding = next();
    else if (arg === "--assets") options.assets = next();
    else if (arg === "--only") options.only = next().split(",");
    else if (arg === "--report") options.report = next();
    else if (arg === "--baseline") options.baseline = next();
    else if (arg === "--browser") options.browser = next();
    else if (arg === "--port") options.port = Number(next());
    else if (arg === "--continue") options.continueAfterPreflight = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`unknown option ${arg}`);
  }
  return options;
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    const options = parse(process.argv.slice(2));
    if (options.help || options.binding === "") {
      console.log("conformance: runs datum-binding-check on a binding\n  node binding-kit/conformance.ts --binding <datum | id | module path> [--assets file] [--only ids] [--report dir] [--baseline report.json] [--browser b] [--port n]");
      process.exitCode = options.help ? 0 : 2;
    } else {
      process.exitCode = await runConformance({ ...options, ...conformanceTargetOf(options.binding, options.assets) });
    }
  } catch (error) {
    console.error(`conformance: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
