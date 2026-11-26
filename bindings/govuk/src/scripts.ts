/**
 * GOV.UK Frontend's own script, started scoped to the form, for
 * the components whose script touches only its own root.
 *
 * What was measured (GOV.UK Frontend 6.6.0 in headless Chrome):
 *
 * - `initAll({ scope })` reaches the shadow DOM when `scope` is an Element in it: the form's
 *   wrapper. The ShadowRoot (not an Element) starts nothing and raises nothing.
 * - A component works only if it never looks up through `document`. Accordion, button, password
 *   input and notification banner are root-only. Character count, radios and checkboxes
 *   (conditional reveal), tabs and the error summary's links call `document.getElementById` or
 *   read the page's custom properties, and fail at init or at the first click.
 * - So the binding opts components in by markup: it writes `data-module="govuk-button"` on the
 *   buttons it draws and never `data-module` for the others, which stay on the no-JavaScript
 *   baseline with their behaviour the renderer's (the count, the tabs, summary focus). `initAll`
 *   starts exactly the components it finds marked.
 * - GOV.UK has no teardown. Its start leaves listeners on `window` and `document`
 *   (`pageshow`, `keyup`, `beforematch`) and timers; {@link startScripts} records those added
 *   while the start runs and removes them in the cleanup (best effort: a listener added later
 *   is not seen).
 * - `initAll` refuses to start unless `<body>` carries `govuk-frontend-supported`; that is the
 *   host's page template (the binding's `formClass` does not count), so without it nothing
 *   starts and the form stays on the baseline. `selfCheck` reports it.
 * - The script is the host's file (`assets.scripts`, a classic script that defines
 *   `window.GOVUKFrontend`), never the binding's: without it the baseline is what is drawn.
 */

/** The part of `window.GOVUKFrontend` this binding uses. */
export interface GovukFrontend {
  initAll(config?: { scope?: Element; onError?: (error: Error, context?: unknown) => void }): void;
}

/** GOV.UK's body class: its own `isSupported()` rule. */
export const SUPPORTED_CLASS = "govuk-frontend-supported";

/** What an Exit this page start marks on `<body>`; removed with the rest if this start added it. */
const EXIT_MARKER = "govukFrontendExitThisPageKeypress";

export interface StartedScripts {
  /** Errors GOV.UK raised for components that did not start (an InitError, a SupportError). */
  readonly errors: readonly string[];
  /** Removes the listeners and timers the start added to `window` and `document`, and the body marker. */
  cleanup(): void;
}

type Recorded = [target: EventTarget, type: string, listener: EventListenerOrEventListenerObject, options: boolean | AddEventListenerOptions | undefined];

/** Puts `value` as an own property of `target`, returning what puts it back as it was. */
function shadow<T extends object, K extends keyof T>(target: T, key: K, value: T[K]): () => void {
  const had = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, writable: true, value });
  return () => {
    if (had) {
      Object.defineProperty(target, key, had);
    } else {
      delete target[key];
    }
  };
}

/**
 * Runs `frontend.initAll({ scope: form })` while recording what it adds to `window` and
 * `document`, so the cleanup can take it away again. Synchronous: the patches live only while the
 * start runs.
 */
export function startScripts(form: Element, frontend: GovukFrontend, win: Window = window, doc: Document = document): StartedScripts {
  const recorded: Recorded[] = [];
  const intervals: number[] = [];
  const errors: string[] = [];
  const markerBefore = doc.body !== null && EXIT_MARKER in doc.body.dataset;

  const nativeWindowAdd = win.addEventListener;
  const nativeDocumentAdd = doc.addEventListener;
  const nativeInterval = win.setInterval;
  const restore = [
    shadow(win, "addEventListener", function (this: Window, type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) {
      recorded.push([win, type, listener, options]);
      return nativeWindowAdd.call(win, type, listener, options);
    } as Window["addEventListener"]),
    shadow(doc, "addEventListener", function (this: Document, type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) {
      recorded.push([doc, type, listener, options]);
      return nativeDocumentAdd.call(doc, type, listener, options);
    } as Document["addEventListener"]),
    shadow(win, "setInterval", function (handler: TimerHandler, timeout?: number, ...rest: unknown[]) {
      const id = nativeInterval.call(win, handler, timeout, ...rest);
      intervals.push(id);
      return id;
    } as Window["setInterval"])
  ];
  try {
    frontend.initAll({
      scope: form,
      onError: (error) => errors.push(`${error.name}: ${String(error.message).split("\n")[0]}`)
    });
  } finally {
    for (const undo of restore.reverse()) {
      undo();
    }
  }

  return {
    errors,
    cleanup() {
      for (const [target, type, listener, options] of recorded.splice(0)) {
        target.removeEventListener(type, listener, options);
      }
      for (const id of intervals.splice(0)) {
        win.clearInterval(id);
      }
      if (!markerBefore && doc.body !== null) {
        delete doc.body.dataset[EXIT_MARKER];
      }
    }
  };
}

/** The host's loaded GOV.UK Frontend, when it gave the script in `assets.scripts`. */
export function frontendOf(scope: typeof globalThis = globalThis): GovukFrontend | undefined {
  const found = (scope as { GOVUKFrontend?: Partial<GovukFrontend> }).GOVUKFrontend;
  return typeof found?.initAll === "function" ? (found as GovukFrontend) : undefined;
}

/**
 * The binding's `connect`: GOV.UK's script scoped to the form, once per mount (a second start on
 * one wrapper raises an InitError per component). Nothing happens without the host's script or
 * without GOV.UK's body class: the baseline stands. A component that fails to start undoes the
 * whole start and is reported, so no field is left half-wired.
 */
export function connectScripts(form: HTMLFormElement): (() => void) | undefined {
  const frontend = frontendOf();
  if (frontend === undefined || !document.body.classList.contains(SUPPORTED_CLASS)) {
    return undefined;
  }
  const started = startScripts(form, frontend);
  if (started.errors.length > 0) {
    started.cleanup();
    throw new Error(`GOV.UK Frontend did not start: ${started.errors.join("; ")}`);
  }
  return started.cleanup;
}
