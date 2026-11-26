/**
 * How an example's page becomes the frame that runs it. The page is the reader's own, unchanged
 * but for two things: the addresses of files this site keeps elsewhere (the bundle folder, a
 * binding, a design system's stylesheet) are pointed at this site's copies, and a short script goes
 * in ahead of the page's own. That script reports what the page does (the events the elements
 * dispatch, what the page logs, its height) and hands the page's requests to addresses that do
 * not exist here (/forms/, /api/, the example's own files) to the docs page, which answers them.
 *
 * The frame is loaded from a blob address with a base of this site's origin, so the page has a real
 * origin and its root-relative addresses resolve as they would on a site.
 */
import { BUNDLE_BASE } from "./page";

/** Messages from the frame to the docs page. */
export type FrameMessage =
  | { kind: "event"; type: string; detail: unknown }
  | { kind: "console"; level: "log" | "warn" | "error"; args: unknown[] }
  | { kind: "request"; id: number; method: string; path: string; headers: Record<string, string>; body: string; bytes?: ArrayBuffer }
  | { kind: "height"; height: number }
  | { kind: "fullWindow"; on: boolean };

/** The paths the frame hands to the docs page instead of the network. */
export const STAND_IN_PATHS = ["/forms/", "/api/"];

// Runs inside the frame, before anything of the page's. Plain script, no imports: it is text here.
function bridge(frameId: string, paths: string[], nested: boolean): void {
  // The docs page is the top window, whether this page is the example's or one it frames.
  const docs = window.top!;
  const send = (message: object): void => docs.postMessage({ datumExample: frameId, ...message }, location.origin);
  // What crosses to the docs page is plain data: functions and the element's own runtime dropped,
  // anything unreadable named.
  const plain = (value: unknown): unknown => {
    try {
      const text = JSON.stringify(value, (key, entry) => (typeof entry === "function" || key === "runtime" ? undefined : entry instanceof Error ? String(entry) : entry));
      // A detail that carries the element's whole runtime is not for a log line.
      return text === undefined || text.length > 40000 ? undefined : JSON.parse(text);
    } catch {
      return String(value);
    }
  };

  // Every event a page could hear on an element, whatever it listens for: one the element
  // dispatches on itself, or one from inside it that crosses its shadow root on the way up.
  const elements = ["datum-form", "datum-form-builder"];
  const dispatch = EventTarget.prototype.dispatchEvent;
  EventTarget.prototype.dispatchEvent = function (event: Event): boolean {
    if (event.type.startsWith("datum-") && this instanceof Element && (elements.includes(this.localName) || (event.bubbles && event.composed && this.getRootNode() instanceof ShadowRoot))) {
      send({ kind: "event", type: event.type, detail: plain((event as CustomEvent).detail) });
    }
    return dispatch.call(this, event);
  };

  for (const level of ["log", "warn", "error"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]): void => {
      send({ kind: "console", level, args: args.map(plain) });
      original(...args);
    };
  }
  window.addEventListener("error", (event) => send({ kind: "console", level: "error", args: [event.message] }));
  window.addEventListener("unhandledrejection", (event) => send({ kind: "console", level: "error", args: [String(event.reason)] }));

  // Requests to the stand-in paths are answered by the docs page; the rest go out as they are.
  const realFetch = window.fetch.bind(window);
  const waiting = new Map<number, (reply: { status: number; body: string | null; headers: Record<string, string>; fail: boolean }) => void>();
  let next = 0;
  window.addEventListener("message", (event) => {
    const reply = event.data as { datumExampleReply?: string; id: number } | null;
    if (event.source !== docs || !reply || reply.datumExampleReply !== frameId) return;
    waiting.get(reply.id)?.(reply as never);
    waiting.delete(reply.id);
  });
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== self.origin || !paths.some((path) => url.pathname.startsWith(path))) {
      return realFetch(input, init);
    }
    // The body as text, and as the bytes sent when it is not text (a file posted as it is).
    const sent = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
    const textual = /json|text|xml|urlencoded/.test(request.headers.get("content-type") ?? "text");
    const body = sent === undefined ? "" : new TextDecoder().decode(sent);
    const id = next++;
    return new Promise<Response>((resolve, reject) => {
      const abort = (): void => {
        waiting.delete(id);
        reject(request.signal.reason ?? new DOMException("The request was aborted.", "AbortError"));
      };
      if (request.signal.aborted) return abort();
      request.signal.addEventListener("abort", abort);
      waiting.set(id, (reply) => {
        request.signal.removeEventListener("abort", abort);
        if (reply.fail) reject(new TypeError("Failed to fetch"));
        else resolve(new Response(reply.body, { status: reply.status, headers: reply.headers }));
      });
      send({ kind: "request", id, method: request.method, path: url.pathname + url.search, headers: Object.fromEntries(request.headers), body, bytes: textual ? undefined : sent });
    });
  };

  // The frame is as tall as the page in it. A page the example frames itself is the example's to size.
  if (nested) return;
  // The builder's own full-window button can fill only this frame, so the docs page is told, and
  // gives the frame the whole window. The docs page can ask the builder to leave it again (Escape).
  document.addEventListener("builder-full-window-change", (event) => send({ kind: "fullWindow", on: (event as CustomEvent<{ fullWindow: boolean }>).detail.fullWindow === true }));
  window.addEventListener("message", (event) => {
    const command = event.data as { datumExampleCommand?: string; fullWindow?: boolean } | null;
    if (event.source !== docs || !command || command.datumExampleCommand !== frameId || command.fullWindow !== false) return;
    const builder = document.querySelector("datum-form-builder") as (Element & { fullWindow?: boolean }) | null;
    if (builder) builder.fullWindow = false;
  });
  window.addEventListener("DOMContentLoaded", () => {
    const report = (): void => send({ kind: "height", height: Math.ceil(document.body.getBoundingClientRect().height) });
    new ResizeObserver(report).observe(document.body);
    report();
  });
}

const FRAME_STYLE = "html { background: #ffffff; color-scheme: light; } body { margin: 0; padding: 16px; font-family: system-ui, sans-serif; }";

export interface FrameSource {
  /** The page as the reader would write it. */
  page: string;
  frameId: string;
  /** Addresses in the page (as written, quotes left out) and the addresses of this site they stand for. */
  rewrites: Record<string, string>;
  /** The paths the docs page answers. */
  paths: string[];
  /** A page the example's own page frames. */
  nested?: boolean;
}

/** The frame's document: the page, its addresses pointed at this site, the bridge ahead of it. */
export function frameDocument(source: FrameSource): string {
  let page = source.page;
  for (const [written, real] of Object.entries(source.rewrites)) page = page.replaceAll(`"${written}`, `"${real}`);
  const style = source.nested ? "" : `<style>${FRAME_STYLE}</style>`;
  const head = `<base href="${location.origin}/">${style}<script>(${bridge.toString()})(${JSON.stringify(source.frameId)}, ${JSON.stringify(source.paths)}, ${source.nested === true});</script>`;
  return page.replace("<head>", `<head>${head}`);
}

/** A blob address for a frame's document. The caller revokes it. */
export function frameAddress(document: string): string {
  return URL.createObjectURL(new Blob([document], { type: "text/html" }));
}
