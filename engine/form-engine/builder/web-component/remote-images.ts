// Remote pictures in the canvas. A definition someone else wrote can name any image URL; opening it must not make the opener's browser request that URL unasked. An image
// from another origin than the page is held back (its `src` parked in `data-remote-src`, a
// "Load remote content?" button in its place) until the author confirms once for that document.
// The confirmation is remembered for the session, per load of a document: the key is a token the
// canvas makes whenever a document is loaded, never the definition's own id (an author picks that,
// so a file reusing a known id would inherit the confirmation). Author CSS and theme
// tokens that fetch from another origin (`url(https://...)`) are held the same way.

/** Load tokens whose remote content the author has agreed to load this session. */
const confirmedDocuments = new Set<string>();

let tokenCounter = 0;

/** A fresh key for one load of a document. */
export function newRemoteLoadToken(): string {
  tokenCounter += 1;
  return `load-${tokenCounter}`;
}

/** A css `url()` naming another origin: an absolute http(s) or protocol-relative address. */
const REMOTE_CSS_URL = /url\(\s*["']?\s*(?:https?:)?\/\//i;

/** Whether stylesheet or style-attribute text would fetch from another origin. */
export function hasRemoteCssUrl(css: string): boolean {
  return REMOTE_CSS_URL.test(css);
}

/** `css` with every remote `url()` made empty, so nothing is requested. */
function withoutRemoteCssUrls(css: string): string {
  return css.replace(/url\(\s*(["']?)\s*(?:https?:)?\/\/[^)]*\)/gi, "url()");
}

export interface RemoteImageGuardOptions {
  /** Names the current load of the document the canvas shows (a token, not the form's id). */
  documentId: () => string;
  /** The button's label and the question the confirmation asks. */
  words: () => { load: string; confirm: string };
}

/** Whether a picture's address names another origin than the page's (data and blob stay local). */
export function isRemoteImage(src: string, page: { href: string; origin: string }): boolean {
  let url: URL;
  try {
    url = new URL(src, page.href);
  } catch {
    return false;
  }
  if (url.protocol === "data:" || url.protocol === "blob:") {
    return false;
  }
  return url.origin !== page.origin;
}

/** Forget every confirmation (tests, and a host that signs the author out). */
export function resetRemoteImageConfirmations(): void {
  confirmedDocuments.clear();
}

/**
 * Holds remote images in `root` (a shadow root the renderer paints into) until the document's
 * remote content is confirmed. Returns a function that stops watching.
 */
export function guardRemoteImages(root: ParentNode & Node, options: RemoteImageGuardOptions): () => void {
  const page = (): { href: string; origin: string } => ({ href: root.ownerDocument?.baseURI ?? "", origin: root.ownerDocument?.location?.origin ?? "" });

  const release = (): void => {
    root.querySelectorAll<HTMLImageElement>("img[data-remote-src]").forEach((image) => {
      image.setAttribute("src", image.dataset.remoteSrc ?? "");
      image.removeAttribute("data-remote-src");
    });
    root.querySelectorAll("[data-remote-load]").forEach((button) => button.remove());
    root.querySelectorAll<HTMLElement>("style[data-remote-css]").forEach((style) => {
      style.textContent = style.getAttribute("data-remote-css") ?? "";
      style.removeAttribute("data-remote-css");
    });
    root.querySelectorAll<HTMLElement>("[data-remote-style]").forEach((node) => {
      node.setAttribute("style", node.getAttribute("data-remote-style") ?? "");
      node.removeAttribute("data-remote-style");
    });
  };

  // Author css and theme tokens: the original text is parked in an attribute and the element
  // carries the same text with its remote urls emptied. A repaint that rewrites the text is held again.
  const holdCss = (): void => {
    root.querySelectorAll<HTMLElement>("style").forEach((style) => {
      const text = style.textContent ?? "";
      const parked = style.getAttribute("data-remote-css");
      if (parked !== null && text === withoutRemoteCssUrls(parked)) {
        return;
      }
      style.removeAttribute("data-remote-css");
      if (hasRemoteCssUrl(text)) {
        style.setAttribute("data-remote-css", text);
        style.textContent = withoutRemoteCssUrls(text);
      }
    });
    root.querySelectorAll<HTMLElement>("[style]").forEach((node) => {
      const text = node.getAttribute("style") ?? "";
      const parked = node.getAttribute("data-remote-style");
      if (parked !== null && text === withoutRemoteCssUrls(parked)) {
        return;
      }
      node.removeAttribute("data-remote-style");
      if (hasRemoteCssUrl(text)) {
        node.setAttribute("data-remote-style", text);
        node.setAttribute("style", withoutRemoteCssUrls(text));
      }
    });
  };

  const scan = (): void => {
    // The builder alone asks for CORS-clean pictures; a live form's images are left as they are.
    root.querySelectorAll<HTMLImageElement>("img:not([crossorigin])").forEach((image) => image.setAttribute("crossorigin", "anonymous"));
    const id = options.documentId();
    if (confirmedDocuments.has(id)) {
      release();
      return;
    }
    holdCss();
    root.querySelectorAll<HTMLImageElement>("img[src]").forEach((image) => {
      const src = image.getAttribute("src") ?? "";
      if (!isRemoteImage(src, page())) {
        // The renderer keeps an <img> across repaints and rewrites its `src` in place: a picture
        // that was held and now names a local address drops the parked remote one and its button.
        if (image.hasAttribute("data-remote-src")) {
          image.removeAttribute("data-remote-src");
          if (image.previousElementSibling?.hasAttribute("data-remote-load")) {
            image.previousElementSibling.remove();
          }
        }
        return;
      }
      image.dataset.remoteSrc = src;
      image.removeAttribute("src");
      if (image.previousElementSibling?.hasAttribute("data-remote-load")) {
        return;
      }
      const button = (image.ownerDocument ?? document).createElement("button");
      button.type = "button";
      button.setAttribute("data-remote-load", "");
      button.textContent = options.words().load;
      image.before(button);
    });
  };

  const onClick = (event: Event): void => {
    const target = event.target as Element | null;
    if (!target?.closest?.("[data-remote-load]")) {
      return;
    }
    const ask = (root.ownerDocument?.defaultView as (Window & typeof globalThis) | null | undefined)?.confirm;
    if (typeof ask === "function" && ask.call(root.ownerDocument?.defaultView, options.words().confirm) === true) {
      confirmedDocuments.add(options.documentId());
      release();
    }
  };

  root.addEventListener("click", onClick);
  const observer = typeof MutationObserver === "function" ? new MutationObserver(scan) : undefined;
  // Attributes too: the renderer rewrites an <img>'s `src` and a node's `style` in place when another
  // document is opened, with no node added. The guard's own writes settle in one more pass.
  observer?.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["src", "style"] });
  scan();
  return () => {
    root.removeEventListener("click", onClick);
    observer?.disconnect();
  };
}
