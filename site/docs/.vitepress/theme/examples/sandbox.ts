/**
 * The sandbox an example's stand-in for a server runs: the same built `datum-wasm.js` the pages
 * load beside the bundle, imported by the docs page from this site's demo/ folder. A real server
 * runs this program in a WASM runtime of its own; the verdict is the same for the same answers.
 */
import { withBase } from "vitepress";

/** What the stand-in passes the sandbox: the definition's tree, the answers, and the journey and page to judge them by. */
export interface SandboxContext {
  formId: string;
  form: unknown;
  values: Record<string, unknown>;
  locale?: string;
  journey?: unknown;
  page?: string;
}

/** The part of the sandbox's verdict the stand-ins read. */
export interface SandboxOutcome {
  errors: Array<{ code: string; componentId?: string }>;
  values?: Record<string, unknown>;
  pageComponentIds?: string[];
}

interface SandboxHost {
  run(request: { context: SandboxContext; policy: Record<string, boolean> }): Promise<SandboxOutcome>;
}

// No network, no files, no process, no environment: the only policy the sandbox accepts.
const STRICT = { allowNetwork: false, allowFilesystem: false, allowProcess: false, allowEnvironment: false };

let host: Promise<SandboxHost> | undefined;

/** Where this site keeps the bundles: demo/ at the site's root, one level above the docs. */
export function demoAddress(file: string): string {
  return new URL(`../demo/${file}`, new URL(withBase("/"), location.href)).href;
}

/** A file of this site's docs/public, as text. */
export async function siteFile(path: string): Promise<string> {
  const response = await fetch(withBase(path));
  if (!response.ok) throw new Error(`${path} answered ${response.status}`);
  return response.text();
}

/** Runs the sandbox once over `context`, loading it on the first call. */
export async function runSandbox(context: SandboxContext): Promise<SandboxOutcome> {
  host ??= import(/* @vite-ignore */ demoAddress("datum-wasm.js")).then(
    (module: { createWasmValidationHost(plugins: unknown[]): Promise<SandboxHost> }) => module.createWasmValidationHost([])
  );
  host.catch(() => (host = undefined));
  return (await host).run({ context, policy: STRICT });
}
