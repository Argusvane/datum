/**
 * A live example on a docs page: the page a reader would write, shown as code, and the same page
 * running in a frame under it. One spec per example; `LiveExample.vue` draws any of them.
 */

/** One choice the reader makes over an example: a list to pick from, or a switch. */
export interface ExampleOption {
  key: string;
  label: string;
  /** The values a select offers. Left out, the option is a switch. */
  choices?: ReadonlyArray<{ value: string; label: string }>;
  default: string | boolean;
  /** Shown only while this holds, for a choice that applies under another one. */
  when?(options: ExampleOptions): boolean;
}

export type ExampleOptions = Record<string, string | boolean>;

/** A file shown beside the page: the definition it loads, a file the server keeps. */
export interface ExampleFile {
  title: string;
  lang: "html" | "javascript" | "json" | "css" | "text";
  code: string;
  /**
   * Where the page finds the file. With it, the frame is served the file at that address: a
   * stylesheet the form fetches, or a page the example's own page frames.
   */
  path?: string;
}

/** A request the running page made to an address the example stands in for. */
export interface ExampleRequest {
  method: string;
  /** Path and query, as the page wrote them. */
  path: string;
  headers: Record<string, string>;
  /** The body read as text. */
  body: string;
  /** The body's bytes, when the page sent something that is not text: a PDF, an image. */
  bytes?: ArrayBuffer;
}

/** What the stand-in answers. `fail` is a server out of reach; `delay` holds the answer back. */
export interface ExampleReply {
  status?: number;
  /** Sent as JSON unless it is a string, or bytes (an ArrayBuffer, a typed array or a Blob), which go as they are. */
  body?: unknown;
  /** The content type of a body that is not JSON: "application/pdf". */
  type?: string;
  /** Response headers besides the content type: `{ etag: '"4"' }`. */
  headers?: Record<string, string>;
  /** Lines the server would have written to its own log, shown in the example's log. */
  log?: string[];
  delay?: number;
  fail?: boolean;
}

export interface ExampleSpec {
  /** Names the frame for assistive technology. */
  title: string;
  options: readonly ExampleOption[];
  /** The whole page, as the reader would write it. The frame runs exactly this. */
  page(options: ExampleOptions): string;
  /**
   * Addresses the page names besides the bundle folder that this site keeps somewhere else, each
   * with its place under the site's root: `{ "/bindings/bootstrap.iife.js": "demo/bindings/…" }`.
   */
  rewrites?: Record<string, string>;
  /** Files shown on tabs beside the page. */
  files?(options: ExampleOptions): ExampleFile[];
  /**
   * The example's stand-in for the page's server: every request the page makes under /api/ (and
   * under `paths`) comes here. Left out, or answering nothing, the request gets a 404. It may take
   * its time: a stand-in that loads a module first answers with a promise.
   */
  serve?(request: ExampleRequest, options: ExampleOptions): ExampleReply | undefined | Promise<ExampleReply | undefined>;
  /** Path prefixes besides /forms/ and /api/ that the frame hands to `serve`: `["/templates/"]`. */
  paths?: readonly string[];
}
