// The conformance suite's programmatic entry is plain ESM (.mjs) without declarations; the kit
// declares the part it calls.
declare module "@argusvane/datum-conformance-suite/binding-check" {
  export class PreflightError extends Error {}
  export function runBindingCheck(argv: readonly string[], io?: { out: (text: string) => void; err: (text: string) => void }): Promise<number>;
  export function buildRun(options: { binding: string; name?: string; extraEntries?: Record<string, string>; esbuild?: unknown; shared?: boolean }): Promise<{
    files: Map<string, { contents: Uint8Array; type: string }>;
    run: string;
    hostUrl: string;
    bindingUrl: string;
    urlOf(entry: string): string;
    dispose(): void;
  }>;
  export const DATUM_BINDING: string;
  export function loadEsbuild(): unknown;
  export function loadPlaywright(): Promise<unknown>;
  export function startBrowser(options: { port?: number; roots?: readonly string[]; builds?: readonly unknown[]; browserName?: string; playwright?: unknown }): Promise<{
    server: { port: number };
    browser: { newContext(options?: object): Promise<any>; version(): string };
    context: unknown;
    name: string;
    version: string;
    open(path: string): Promise<unknown>;
    close(): Promise<void>;
  }>;
  export const FIXTURES: Record<string, { id: string; definition: unknown; preset?: Record<string, unknown> }>;
  export const CASES: readonly { id: string; group: string; title: string; pending?: boolean }[];
  export const GROUPS: Record<string, string>;
  export const RUN_PREFIX: string;
  export function startServer(options?: { port?: number; roots?: readonly string[]; files?: Map<string, { contents: Uint8Array | string; type: string }> }): Promise<{ port: number; files: Map<string, { contents: Uint8Array | string; type: string }>; close(): Promise<void> }>;
  export function resolveTarget(args: { binding?: string; assets?: string }): unknown;
}
