import { PRINT_TRUSTED_TYPES_POLICY } from "./print-policy.js";

/**
 * Presents a print document through a hidden, same-origin frame.
 *
 * `<datum-form-renderer>` prints the form, not the page: the host's app bar, rails and toolbar
 * never appear, and no host has to write `@media print` rules to hide them. The frame is
 * `about:blank`, so it shares the page's origin and inherits the page's content security policy;
 * the document it is given (`render/print/`) is static markup that says it runs no script
 * (`script-src 'none'`).
 *
 * The frame holds under a strict host policy:
 * - The document is parsed off to one side (`DOMParser`) and its nodes brought into the frame, so
 *   nothing is written through `document.write`. Under Trusted Types
 *   (`require-trusted-types-for 'script'`) the parse goes through a policy named `datum-print`,
 *   which a host allows beside lit-html's: `trusted-types lit-html datum-print`. Its one input is
 *   the print document, whose every value the `printHtml` tag escaped.
 * - The document's `<style>` sheets are applied as constructed sheets (`adoptedStyleSheets`), which
 *   a `style-src` without `'unsafe-inline'` allows, as it allows the live form's; the host's own
 *   stylesheet links load under its `style-src` as on the page.
 * - The frame's own placement is set through CSSOM, not a `style` attribute.
 *
 * Nothing here touches a DOM global at module scope: the render barrel is imported under Node
 * (see `custom-element-base.ts`), so the DOM is only reached inside these functions.
 */

/** Marks the frame a renderer appended to `document.body`, for a host or a test to find. */
export const PRINT_FRAME_ATTR = "data-datum-print-frame";

/** What is about to print: the document, and why the chosen theme was set aside, when it was. */
export interface PresentedPrintDocument {
  html: string;
  /** The id of the theme the document is drawn with (`fallback`'s when the self-check failed). */
  theme?: string | undefined;
  fellBack?: string[] | undefined;
}

export interface PresentPrintDocumentOptions {
  /** Upper bound on waiting for the stylesheets, fonts and images before printing anyway. Default 4000. */
  timeoutMs?: number;
  /**
   * Run once the document's stylesheets and fonts are in (a print theme's `selfCheck`): what keeps
   * it from printing as drawn. With problems, {@link fallback}'s document is written in its place.
   * When absent, nothing needs the frame before {@link beforePrint}, so it is asked first and a
   * refusal opens no frame at all.
   */
  selfCheck?: ((doc: Document) => readonly string[]) | undefined;
  /** The document to print when {@link selfCheck} finds problems. */
  fallback?: (() => { html: string; theme: string }) | undefined;
  /** The theme `html` is drawn with, reported to {@link beforePrint}. */
  theme?: string | undefined;
  /** Why the chosen theme was set aside already, before the frame (a drawer that refused). */
  fellBack?: string[] | undefined;
  /**
   * The last word before the dialog, with the document that will print: `false` prints nothing
   * (the frame, if one was made, is removed). The `datum-print` event.
   */
  beforePrint?: ((presented: PresentedPrintDocument) => boolean) | undefined;
}

export interface PresentPrintResult extends PresentedPrintDocument {
  /** The frame `print()` was called in; absent when {@link PresentPrintDocumentOptions.beforePrint} refused. */
  frame?: HTMLIFrameElement | undefined;
}

const DEFAULT_ASSET_TIMEOUT_MS = 4000;

/*
 * Off-screen, not display:none — Firefox declines to print a frame that has no box — and at
 * a paper-like width, so anything keyed off the frame's own size lays out the way a page would.
 * Set property by property (CSSOM): a `style` attribute is refused under a strict `style-src`.
 */
const FRAME_STYLE: ReadonlyArray<readonly [string, string]> = [
  ["position", "fixed"],
  ["top", "0"],
  ["left", "-10000px"],
  ["width", "210mm"],
  ["height", "1px"],
  ["border", "0"],
  ["opacity", "0"],
  ["pointer-events", "none"]
];


interface TrustedHtmlPolicy {
  createHTML(input: string): unknown;
}

/** One policy per window (a second `createPolicy` of a name throws); `null` when the page refused it. */
const policies = new WeakMap<object, TrustedHtmlPolicy | null>();

function printPolicy(win: Window): TrustedHtmlPolicy | null {
  if (policies.has(win)) {
    return policies.get(win) ?? null;
  }
  const factory = (win as { trustedTypes?: { createPolicy(name: string, rules: { createHTML(input: string): string }): TrustedHtmlPolicy } }).trustedTypes;
  if (!factory || typeof factory.createPolicy !== "function") {
    // No Trusted Types in this browser: nothing enforces them either.
    return null;
  }
  let policy: TrustedHtmlPolicy | null = null;
  try {
    // The input is the print document: static markup whose every value `printHtml` escaped.
    policy = factory.createPolicy(PRINT_TRUSTED_TYPES_POLICY, { createHTML: (input) => input });
  } catch {
    // The page's `trusted-types` directive does not name it: a page that enforces them refuses the parse below.
    policy = null;
  }
  policies.set(win, policy);
  return policy;
}

/** The print document parsed into an inert document, through the `datum-print` policy when the page has Trusted Types. */
function parsePrintDocument(html: string, hostDocument: Document): Document {
  const win = hostDocument.defaultView;
  if (!win) {
    throw new Error("[datum-form-renderer] The page has no window to print from.");
  }
  const policy = printPolicy(win);
  const input = policy ? policy.createHTML(html) : html;
  try {
    return new win.DOMParser().parseFromString(input as string, "text/html");
  } catch (error) {
    if (error instanceof TypeError && /trusted/i.test(error.message)) {
      throw new Error(
        `[datum-form-renderer] This page enforces Trusted Types and does not allow the "${PRINT_TRUSTED_TYPES_POLICY}" policy print draws through: add it to the page's trusted-types directive (trusted-types lit-html ${PRINT_TRUSTED_TYPES_POLICY}).`,
        { cause: error }
      );
    }
    throw error;
  }
}

/** Waits for the document's stylesheets, then its fonts and images, but never longer than `timeoutMs`. */
export async function waitForPrintAssets(doc: Document, timeoutMs: number): Promise<void> {
  const links = Array.from(doc.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'));
  const sheets = links.map(
    (link) =>
      new Promise<void>((resolve) => {
        // A sheet already parsed has its `sheet`; one that failed fires `error` (CORS, integrity, 404).
        if (link.sheet) {
          resolve();
          return;
        }
        link.addEventListener("load", () => resolve(), { once: true });
        link.addEventListener("error", () => resolve(), { once: true });
      })
  );
  const rest = async (): Promise<void> => {
    await Promise.all(sheets);
    // Faces are only fetched once text uses them: one layout first, then wait.
    void doc.body?.offsetHeight;
    const waits: Promise<unknown>[] = [];
    // Neither is guaranteed: jsdom has no `document.fonts`, and `decode` is newer than `complete`.
    const fonts = (doc as { fonts?: FontFaceSet }).fonts;
    if (fonts?.ready) {
      waits.push(fonts.ready.catch(() => undefined));
    }
    for (const img of Array.from(doc.images)) {
      // An image never loads lazily in an off-screen frame.
      if (img.loading === "lazy") {
        img.loading = "eager";
      }
      if (!img.complete && typeof img.decode === "function") {
        waits.push(img.decode().catch(() => undefined));
      }
    }
    await Promise.all(waits);
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  try {
    // Always at least one await, so a caller's continuation runs after any microtask queued
    // by appending the frame (a MutationObserver stubbing the frame's `print`, in tests).
    await Promise.race([rest(), timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function openFrame(hostDocument: Document): { frame: HTMLIFrameElement; doc: Document; win: Window } {
  const frame = hostDocument.createElement("iframe");
  frame.setAttribute(PRINT_FRAME_ATTR, "");
  frame.setAttribute("aria-hidden", "true");
  frame.setAttribute("tabindex", "-1");
  frame.setAttribute("title", "Print");
  for (const [property, value] of FRAME_STYLE) {
    frame.style.setProperty(property, value);
  }
  hostDocument.body.append(frame);
  const doc = frame.contentDocument;
  const win = frame.contentWindow;
  if (!doc || !win) {
    frame.remove();
    throw new Error(
      "[datum-form-renderer] The print frame has no document; a sandbox or content security policy may be blocking it."
    );
  }
  return { frame, doc, win };
}

function copyAttributes(from: Element, to: Element): void {
  for (const name of to.getAttributeNames()) {
    to.removeAttribute(name);
  }
  for (const attribute of Array.from(from.attributes)) {
    to.setAttribute(attribute.name, attribute.value);
  }
}

/**
 * Puts the print document into the frame without an HTML sink in the frame: parsed off to one
 * side, its policy meta first (so nothing after it runs a handler), then the other head nodes,
 * the sheets as constructed ones (as `<style>` only where a browser has no `adoptedStyleSheets`),
 * and the body. Exported for a frame of the caller's own that shows the document on screen (the
 * builder's Print workspace preview), written the same way.
 */
export function writePrintDocument(doc: Document, win: Window, html: string, hostDocument: Document): void {
  const parsed = parsePrintDocument(html, hostDocument);
  // A fresh, empty document in the same frame (the Document and its window stay): no write needed.
  doc.open();
  doc.close();
  // Some engines leave the closed document without its elements (jsdom); others parse html, head and body.
  const root = doc.documentElement ?? doc.appendChild(doc.createElement("html"));
  copyAttributes(parsed.documentElement, root);
  const head = doc.head ?? root.appendChild(doc.createElement("head"));
  const body = doc.body ?? root.appendChild(doc.createElement("body"));
  head.replaceChildren();
  body.replaceChildren();
  const from = Array.from(parsed.head.childNodes);
  const elements = from.filter((node): node is Element => node.nodeType === 1);
  const metas: Node[] = elements.filter((element) => element.localName === "meta" && element.hasAttribute("http-equiv"));
  const styles: Node[] = elements.filter((element) => element.localName === "style");
  for (const node of [...metas, ...from.filter((node) => !metas.includes(node) && !styles.includes(node))]) {
    head.append(doc.importNode(node, true));
  }
  const css = styles.map((style) => style.textContent ?? "");
  const Sheet = (win as unknown as { CSSStyleSheet?: { new (): CSSStyleSheet } }).CSSStyleSheet;
  if ("adoptedStyleSheets" in doc && Sheet && typeof Sheet.prototype.replaceSync === "function") {
    doc.adoptedStyleSheets = css.map((text) => {
      const sheet = new Sheet();
      sheet.replaceSync(text);
      return sheet;
    });
  } else {
    for (const text of css) {
      const style = doc.createElement("style");
      style.textContent = text;
      head.append(style);
    }
  }
  copyAttributes(parsed.body, body);
  body.append(...Array.from(parsed.body.childNodes, (node) => doc.importNode(node, true)));
}

/**
 * Appends a hidden frame to `hostDocument.body`, writes `html` into it, waits for its
 * stylesheets, fonts and images, runs the self-check (writing the fallback's document instead
 * when it finds problems, with a console warning), asks `beforePrint`, and calls the frame
 * window's `print()`. Resolves once `print()` has been called — Chrome and Firefox return when
 * the dialog closes, Safari at once — or once `beforePrint` refused.
 *
 * The frame removes itself on its window's `afterprint`. Chrome fires that inside `print()`
 * itself, so the frame is already gone when this resolves; Firefox fires it once the dialog
 * closes; Safari may never. A caller therefore checks `isConnected` before keeping the frame,
 * and removes a kept one on its next print or when it leaves the page — never on a timer, which
 * would tear a still-open dialog's document away.
 */
export async function presentPrintDocument(
  html: string,
  hostDocument: Document,
  options: PresentPrintDocumentOptions = {}
): Promise<PresentPrintResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_ASSET_TIMEOUT_MS;
  let presented: PresentedPrintDocument = {
    html,
    ...(options.theme !== undefined ? { theme: options.theme } : {}),
    ...(options.fellBack !== undefined ? { fellBack: options.fellBack } : {})
  };
  // Nothing to check in the frame: the host may take the document over before a frame exists.
  if (!options.selfCheck && options.beforePrint && !options.beforePrint(presented)) {
    return presented;
  }
  const { frame, doc, win } = openFrame(hostDocument);
  try {
    writePrintDocument(doc, win, html, hostDocument);
    await waitForPrintAssets(doc, timeoutMs);
    if (options.selfCheck) {
      const problems = options.selfCheck(doc);
      if (problems.length > 0 && options.fallback) {
        const fallback = options.fallback();
        console.warn(
          `[datum-form-renderer] the "${options.theme ?? "chosen"}" print theme cannot print as it should (${problems.join("; ")}); printed with the "${fallback.theme}" print theme instead.`
        );
        presented = { html: fallback.html, theme: fallback.theme, fellBack: [...(options.fellBack ?? []), ...problems] };
        writePrintDocument(doc, win, fallback.html, hostDocument);
        await waitForPrintAssets(doc, timeoutMs);
      }
      if (options.beforePrint && !options.beforePrint(presented)) {
        frame.remove();
        return presented;
      }
    }
  } catch (error) {
    frame.remove();
    throw error;
  }

  win.addEventListener("afterprint", () => frame.remove(), { once: true });
  try {
    win.print();
  } catch (error) {
    frame.remove();
    throw error;
  }
  return { ...presented, frame };
}
