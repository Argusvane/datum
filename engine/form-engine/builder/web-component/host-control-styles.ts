/**
 * The builder's look for the controls a host slots onto it: a button or a select on the bar
 * (`toolbar-start`, `toolbar`, `canvas-actions`) and a launcher on the activity strip
 * (`strip`). They are the host's elements, in the host's tree, so the shell's own stylesheet
 * cannot reach them except through `::slotted()`, and a `::slotted()` rule loses to any
 * page-level `button {}` reset (Bootstrap's reboot, normalize) because the outer context wins
 * for normal declarations. So the look ships as a small stylesheet each builder installs into
 * its own root node: the document, or the shadow root the builder lives in.
 *
 * Every selector is held to one element's weight, (0,0,1), by `:where()`: a bare element
 * reset of the same weight earlier in the cascade loses (an adopted sheet comes after the
 * document's own sheets), and a class of the host's wins, in every state. Colours, corners
 * and sizes come from the `--db-*` tokens the shell declares on its host, which the slotted
 * controls inherit through the flat tree; no token of its own. The one fallback is the bar's tool
 * size, which the shell sets on its bar, not its host.
 */

/**
 * Selects a host's bar control of one element type, slotted into any of the builder elements:
 * the engine's shell, the package's wrapper, and the PDF designer the wrapper is the base of.
 * `slots` narrows it to some of the bar's slots (the leading pill's, or the trailing ones).
 */
function barControl(element: "button" | "select", slots: readonly string[] = ["toolbar-start", "toolbar", "canvas-actions", "history", "comments", "publish", "account"]): string {
  return `:where(datum-builder, datum-form-builder) > ${element}:where(${slots.map((slot) => `[slot="${slot}"]`).join(", ")})`;
}

const BAR_BUTTON = barControl("button");
const BAR_SELECT = barControl("select");
/** In the leading pill (.bar-start), beside undo and redo: borderless, like the shell's own bar buttons. */
const LEAD_BUTTON = barControl("button", ["toolbar-start"]);
/** On the backdrop at the bar's end: a pill of its own. */
const END_BUTTON = barControl("button", ["toolbar", "canvas-actions", "history", "comments", "publish", "account"]);
const END_SELECT = barControl("select", ["toolbar", "canvas-actions", "history", "comments", "publish", "account"]);
const STRIP_BUTTON = `:where(datum-builder, datum-form-builder) > button:where([slot="strip"])`;
// A phone's bottom bar marks the host's strip items data-bottom-item: each is a tab as wide as the shell's.

/**
 * The stylesheet {@link adoptBuilderHostControlStyles} installs: the bar's button and select, the strip's launcher.
 *
 * The studio look: a host's control at the bar's end is a pill
 * on the backdrop — the surface, a card outline, the pill corner and shadow, the control height
 * — and one in the leading pill is a round borderless button like undo and redo. A host marks
 * its primary action (Save) with `data-builder-primary` for the accent pill; a class of the
 * host's own Save still wins. An icon-only button is a circle: the side padding is
 * what is left of the control height around the glyph, so a word grows the pill to fit.
 */
export const BUILDER_HOST_CONTROL_STYLES = `
${BAR_BUTTON}, ${BAR_SELECT} {
  box-sizing: border-box;
  min-width: var(--db-control-h); height: var(--db-control-h);
  margin: 0;
  border: var(--db-border-w) solid var(--db-line-card);
  border-radius: var(--db-radius-pill);
  color: var(--db-ink);
  font: inherit; font-family: var(--db-font); font-size: var(--db-text-base); font-weight: 500;
  line-height: 1; text-transform: none; letter-spacing: normal;
  cursor: pointer;
  transition: background var(--db-motion-fast) var(--db-ease);
}
${BAR_BUTTON} {
  display: inline-flex; align-items: center; justify-content: center; gap: var(--db-space-2);
  padding: 0 calc((var(--db-control-h) - var(--db-icon-size)) / 2 - var(--db-border-w));
  background: var(--db-surface);
  white-space: nowrap;
}
${END_BUTTON}, ${END_SELECT} { box-shadow: var(--db-shadow-pill); }
${LEAD_BUTTON} {
  min-width: var(--db-bar-tool, 38px); height: var(--db-bar-tool, 38px);
  padding: 0 calc((var(--db-bar-tool, 38px) - var(--db-icon-size)) / 2);
  border-color: transparent; background: transparent; color: var(--db-ink-muted);
}
${BAR_SELECT} {
  padding-block: 0; padding-inline: var(--db-space-4) var(--db-space-3);
  background: var(--db-surface);
}
${BAR_BUTTON} > :where(svg), ${STRIP_BUTTON} > :where(svg) {
  width: var(--db-icon-size); height: var(--db-icon-size); flex: none;
}
${BAR_BUTTON}:where(:hover:not(:disabled)), ${BAR_SELECT}:where(:hover:not(:disabled)) { background: var(--db-surface-hover); color: var(--db-ink); }
${BAR_BUTTON}:where(:disabled), ${BAR_SELECT}:where(:disabled) { opacity: .4; cursor: default; }
${BAR_BUTTON}:where([aria-pressed="true"]) {
  background: var(--db-selected); border-color: var(--db-selected); color: var(--db-selected-ink);
}
${BAR_BUTTON}:where([data-builder-primary]) {
  background: var(--db-accent); border-color: var(--db-accent); color: var(--db-accent-ink);
}
${BAR_BUTTON}:where([data-builder-primary]:hover:not(:disabled)) { background: var(--db-accent-hover); border-color: var(--db-accent-hover); color: var(--db-accent-ink); }
${BAR_BUTTON}:where(:focus-visible), ${BAR_SELECT}:where(:focus-visible), ${STRIP_BUTTON}:where(:focus-visible) {
  outline: 2px solid var(--db-focus); outline-offset: 2px;
}
${STRIP_BUTTON} {
  display: inline-flex; align-items: center; justify-content: center;
  box-sizing: border-box; width: 40px; height: 40px; margin: 0; padding: 0;
  border: 0; border-radius: var(--db-radius-pill);
  background: transparent; color: var(--db-ink-muted);
  font: inherit; line-height: 1; cursor: pointer;
  transition: background var(--db-motion-fast) var(--db-ease);
}
${STRIP_BUTTON}:where(:hover) { background: var(--db-surface-hover); color: var(--db-ink); }
${STRIP_BUTTON}:where([aria-selected="true"]) {
  background: var(--db-selected); color: var(--db-selected-ink);
}
${BAR_BUTTON}:where([hidden]), ${BAR_SELECT}:where([hidden]), ${STRIP_BUTTON}:where([hidden]) { display: none; }
${STRIP_BUTTON}:where([data-bottom-item]) { flex: 1 1 0; min-width: 0; width: auto; height: 48px; border-radius: var(--db-radius-lg); }
${STRIP_BUTTON}:where([data-bottom-item][aria-selected="true"]) { background: var(--db-surface-sunken); color: var(--db-ink); }
`;

/** The marker on the `<style>` element installed where constructable stylesheets are not available. */
const STYLE_MARKER = "data-datum-host-controls";

/** The roots the stylesheet was installed into. */
const installed = new WeakSet<Document | ShadowRoot>();

/** One constructed sheet per document: a constructed sheet can only be adopted by roots of the document that made it. */
const sheets = new WeakMap<Document, CSSStyleSheet>();

/** Whether a node is a root the stylesheet can go into: a document, or a shadow root. */
export function isBuilderHostControlRoot(node: Node | null | undefined): node is Document | ShadowRoot {
  if (!node) {
    return false;
  }
  return node.nodeType === 9 || (node.nodeType === 11 && "host" in node);
}

function ownerDocumentOf(root: Document | ShadowRoot): Document {
  return root.nodeType === 9 ? (root as Document) : (root as ShadowRoot).ownerDocument;
}

/** The document's constructed sheet, made on first use; `undefined` where constructable stylesheets are not supported. */
function constructedSheet(root: Document | ShadowRoot): CSSStyleSheet | undefined {
  if (!("adoptedStyleSheets" in root)) {
    return undefined;
  }
  const doc = ownerDocumentOf(root);
  const existing = sheets.get(doc);
  if (existing) {
    return existing;
  }
  const view = doc.defaultView as (Window & { CSSStyleSheet?: typeof CSSStyleSheet }) | null;
  const Sheet = view?.CSSStyleSheet ?? (typeof CSSStyleSheet === "function" ? CSSStyleSheet : undefined);
  if (typeof Sheet !== "function" || typeof Sheet.prototype.replaceSync !== "function") {
    return undefined;
  }
  try {
    const sheet = new Sheet();
    sheet.replaceSync(BUILDER_HOST_CONTROL_STYLES);
    sheets.set(doc, sheet);
    return sheet;
  } catch {
    return undefined;
  }
}

/** Whether the stylesheet is in the root now: adopted, or as its marked `<style>`. */
function present(root: Document | ShadowRoot): boolean {
  const sheet = sheets.get(ownerDocumentOf(root));
  if (sheet && "adoptedStyleSheets" in root && root.adoptedStyleSheets.includes(sheet)) {
    return true;
  }
  return root.querySelector(`style[${STYLE_MARKER}]`) !== null;
}

/**
 * Installs {@link BUILDER_HOST_CONTROL_STYLES} into a root node — the document, or a shadow
 * root a builder lives in — once: a second call for the same root does nothing while the
 * sheet is still there (a host that replaced the root's adopted sheets gets it back on the
 * next call). Adopted as a constructed stylesheet where the browser has them, so it comes
 * after the document's own sheets and wins their ties; otherwise a `<style
 * data-datum-host-controls>` appended to the document's head or the shadow root. Never throws.
 */
export function adoptBuilderHostControlStyles(root: Document | ShadowRoot): void {
  try {
    if (installed.has(root) && present(root)) {
      return;
    }
    const sheet = constructedSheet(root);
    if (sheet) {
      if (!root.adoptedStyleSheets.includes(sheet)) {
        root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
      }
      installed.add(root);
      return;
    }
    if (root.querySelector(`style[${STYLE_MARKER}]`) === null) {
      const doc = ownerDocumentOf(root);
      const style = doc.createElement("style");
      style.setAttribute(STYLE_MARKER, "");
      style.textContent = BUILDER_HOST_CONTROL_STYLES;
      const parent = root.nodeType === 9 ? (doc.head ?? doc.documentElement) : root;
      parent?.append(style);
    }
    installed.add(root);
  } catch {
    // A root that refuses the sheet (a closed or foreign document) keeps the host's own look.
  }
}
