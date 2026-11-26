/**
 * What the server examples' stand-ins share. Each example's page delivers to an endpoint that runs
 * the sandbox program, and for a PDF the PDF program, on the server. The docs have no server, so
 * the docs page answers in its place with the same programs, taken from the built files this site
 * keeps beside its bundles: datum-wasm.js runs the sandbox in a WASM build of a JavaScript engine,
 * and datum-pdf.js is the PDF kernel. The endpoint files the pages show are what a real server runs;
 * this file only does in the browser what they do, step for step.
 */
import { withBase } from "vitepress";

import { SAMPLE_DATA_SOURCES } from "./page";
import type { ExampleReply } from "./types";

/** The site's copy of the bundle folder: one level above the docs, as LiveExample.vue finds it. */
export function bundleFolder(): string {
  return `${new URL("../", new URL(withBase("/"), location.href)).pathname}demo/`;
}

/** A file the docs site serves from docs/public: the server's own copy of a form or a template. */
async function siteFile(path: string): Promise<Response> {
  const response = await fetch(withBase(path));
  if (!response.ok) throw new Error(`The stand-in could not read ${path}: ${response.status}`);
  return response;
}

// --- the modules, as the built files export them ----------------------------------------------

export interface RunLogEntry {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  data?: unknown;
}

export interface SandboxOutcome {
  errors: Array<{ code: string; componentId?: string }>;
  values?: Record<string, unknown>;
  logs?: RunLogEntry[];
}

interface SandboxHost {
  run(request: { context: object; policy: object }): Promise<SandboxOutcome>;
  dispose(): void;
}

interface SandboxModule {
  createWasmValidationHost(plugins: Array<{ id: string; version: string; source: string }>): Promise<SandboxHost>;
}

export interface PdfWarning {
  code: string;
  message: string;
}

export interface PdfSignatureReport {
  field: string;
  signer: { subject: string; certificate: string; publicKey: string } | null;
  signingTime: string | null;
  digestMatches: boolean;
  certificateMatches: boolean;
  coversDocument: boolean;
  certification: unknown;
  timestamp?: unknown;
  toBeVerified: string;
  signature: string;
  signatureP1363?: string;
  signatureAlgorithm: string;
}

export interface PdfProvider {
  abiVersion: string;
  document(request: object): Promise<{
    bytes: Uint8Array;
    pageCount: number;
    warnings: PdfWarning[];
    fields?: Array<{ pdfField: string; status: string; kind?: string }>;
    signing?: { toBeSigned: string; toBeSignedDigest: string; signatureAlgorithm: string };
  }>;
  complete(request: object): Promise<{ bytes: Uint8Array; field: string; timestamped: boolean }>;
  verify(request: object): Promise<{ signatures: PdfSignatureReport[]; attachments: Array<{ name: string; sha256: string }> }>;
}

interface PdfModule {
  DEFAULT_FONT_PACK: Array<{ id: string }>;
  createInProcessPdfProvider(): PdfProvider;
  loadFontPack(options: { baseUrl: string; entries: unknown[] }): Promise<unknown[]>;
}

/** A module of the bundle folder, imported at run time as a reader's own page would. */
function bundleModule<T>(file: string): Promise<T> {
  return import(/* @vite-ignore */ `${bundleFolder()}${file}`) as Promise<T>;
}

/** Loaded once per page, and tried again after a failure. */
function once<T>(load: () => Promise<T>): () => Promise<T> {
  let loading: Promise<T> | undefined;
  return () => {
    loading ??= load().catch((error: unknown) => {
      loading = undefined;
      throw error;
    });
    return loading;
  };
}

const sandboxes = new Map<string, () => Promise<SandboxHost>>();

/** The sandbox program, with the given rule modules registered into it: what the endpoint's VALIDATE runs. */
function sandbox(rules: string | undefined): Promise<SandboxHost> {
  const key = rules ?? "";
  let load = sandboxes.get(key);
  if (!load) {
    load = once(async () => {
      const { createWasmValidationHost } = await bundleModule<SandboxModule>("datum-wasm.js");
      return createWasmValidationHost(rules === undefined ? [] : [{ id: "intake-rules", version: "1.0.0", source: rules }]);
    });
    sandboxes.set(key, load);
  }
  return load();
}

/** The PDF kernel and the two DejaVu fonts the endpoints embed, read from fonts/ beside the bundles. */
export const pdfKernel = once(async () => {
  const { DEFAULT_FONT_PACK, createInProcessPdfProvider, loadFontPack } = await bundleModule<PdfModule>("datum-pdf.js");
  const wanted = new Set(["dejavu-sans", "dejavu-sans-bold"]);
  const fonts = await loadFontPack({ baseUrl: `${bundleFolder()}fonts/`, entries: DEFAULT_FONT_PACK.filter((entry) => wanted.has(entry.id)) });
  return { provider: createInProcessPdfProvider(), fonts };
});

// --- what the server keeps --------------------------------------------------------------------

export interface ServerForm {
  id: string;
  root: object;
  pdf?: { layouts: Array<{ id: string }> };
  journey?: { journeys?: Array<{ id: string }> };
}

const forms = new Map<string, Promise<ServerForm>>();

/** The server's copy of a form, from docs/public/forms. */
export function serverForm(path: string): Promise<ServerForm> {
  let form = forms.get(path);
  if (!form) {
    form = siteFile(path).then((response) => response.json() as Promise<ServerForm>);
    form.catch(() => forms.delete(path));
    forms.set(path, form);
  }
  return form;
}

/** A file the server keeps beside its programs: a template PDF's bytes. */
export async function serverBytes(path: string): Promise<Uint8Array> {
  return new Uint8Array(await (await siteFile(path)).arrayBuffer());
}

/** What the Country select shows, resolved by the server: the program never fetches a data source. */
export const COUNTRIES = SAMPLE_DATA_SOURCES.countries;

// --- the steps every endpoint takes -----------------------------------------------------------

export interface Envelope {
  submission: { values: Record<string, unknown>; locale?: string; journey?: { id?: string } };
}

/** The request body as JSON, or nothing for a body that is not. */
export function json<T>(body: string): T | undefined {
  try {
    return JSON.parse(body) as T;
  } catch {
    return undefined;
  }
}

// The sandbox reaches nothing: no network, no file system, no process, no environment.
const POLICY = { allowNetwork: false, allowFilesystem: false, allowProcess: false, allowEnvironment: false };

/**
 * The validation run: the server's copy of the form, the submitted values and what only the server
 * knows, through the sandbox program. A run that ends without an outcome fails closed, as the
 * endpoints do.
 */
export async function validate(form: ServerForm, envelope: Envelope, extra: { rules?: string; externalData?: object; logLevel?: string } = {}): Promise<SandboxOutcome> {
  const submission = envelope.submission;
  const named = submission.journey?.id;
  const context = {
    formId: form.id,
    form: form.root,
    values: submission.values,
    locale: submission.locale ?? "en",
    ...(extra.externalData ? { externalData: extra.externalData } : {}),
    optionSnapshot: { countries: COUNTRIES },
    journey: form.journey?.journeys?.find((journey) => journey.id === named) ?? null,
    ...(extra.logLevel ? { logLevel: extra.logLevel } : {})
  };
  const host = await sandbox(extra.rules);
  try {
    return await host.run({ context, policy: POLICY });
  } catch {
    return { errors: [{ code: "wasm.execution_error" }] };
  }
}

/** A 422 with the error contract: codes and fields, never text. */
export function rejected(outcome: SandboxOutcome, log: string[] = []): ExampleReply {
  const errors = outcome.errors.map((error) => ({ field: error.componentId ?? null, code: error.code }));
  return { status: 422, body: { errors }, log: [...log, `422: ${errors.map((error) => `${error.field ?? "form"} ${error.code}`).join(", ")}`] };
}

/** A PDF run that failed: the kernel's code, as the endpoints answer it. */
export function failed(error: unknown): ExampleReply {
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : String(error);
  return { status: 500, body: { error: { code: typeof code === "string" ? code : "internal", message } }, log: [`the PDF program failed: ${message}`] };
}

/** The only time and identity the PDF program sees. */
export function env(): { createdAt: string; documentId: string } {
  return { createdAt: new Date().toISOString().replace(/\.\d{3}Z$/, ".000Z"), documentId: crypto.randomUUID() };
}

/** A run log entry as the endpoints forward it to their logger. */
export function logLine(entry: RunLogEntry): string {
  return `${entry.level} ${entry.message}${entry.data === undefined ? "" : ` ${JSON.stringify(entry.data)}`}`;
}

export function warningLines(warnings: PdfWarning[]): string[] {
  return warnings.map((warning) => `warning ${warning.code}: ${warning.message}`);
}

export function toBase64(bytes: Uint8Array): string {
  let text = "";
  for (let at = 0; at < bytes.length; at += 0x8000) text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(text);
}

export function fromBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
}
