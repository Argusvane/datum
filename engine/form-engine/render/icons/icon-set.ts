import { BUILTIN_GLYPHS, BUILTIN_ICON_ATTRS } from "./builtin-icons.js";
import type { DatumIconName } from "./icon-names.js";

/**
 * Pluggable icons for the engine's chrome. The builder shell, the canvas toolbar,
 * the component palette, the drag grips and the form host's action row draw every glyph by
 * name through an {@link IconSet}; which set is a host's choice — the Font Awesome package the
 * `datum-icons-fontawesome.js` bundle registers, the host's own SVGs, a sprite,
 * an icon font — and the engine itself ships only {@link BUILTIN_ICONS}, a small fallback with
 * no library behind it.
 *
 * A set is trusted the way a theme's `css` is: its markup is written into shadow roots as-is,
 * so it is the page author's to supply, never a form's. (The palette's text override on
 * `BuilderComponentType.icon` stays escaped for that reason — it is data.)
 *
 * Resolution is at render time, never at import: a glyph is looked up when the control that
 * shows it is drawn, so registering a set before the elements upgrade, or setting `icons` on
 * an element, is what changes the drawing.
 */
export interface IconSet {
  /** Names the set, for diagnostics and for a host picking among several. */
  id: string;
  /**
   * The inline markup for one glyph, or `undefined` for a name this set has no drawing for —
   * the engine then draws its built-in one, so a partial set is a complete set. `size` is the
   * CSS pixel box the glyph should fill; `className` goes on the outermost element.
   */
  icon(name: DatumIconName, options: IconRenderOptions): string | undefined;
  /**
   * CSS the glyphs need wherever they are drawn — an icon font's class rules, a sprite's
   * sizing. Every shadow root that draws the set writes it into its own `<style>`. The font
   * file itself is the page's to load: an `@font-face` declared in the document applies
   * inside shadow roots, the class rule that names it does not.
   */
  css?: string | undefined;
}

export interface IconRenderOptions {
  /** The CSS pixel box the glyph fills; square. */
  size: number;
  /** Class(es) for the glyph's outermost element. */
  className?: string | undefined;
}

/** One inline-SVG glyph: the drawing's own coordinate space and its inner markup. */
export interface SvgGlyph {
  viewBox: string;
  /** The `<svg>`'s inner markup (`<path>`, `<circle>`, …). */
  body: string;
  /** Attributes on the `<svg>` itself (a stroke style for a stroke-drawn glyph). */
  attrs?: string | undefined;
}

export interface SvgIconSetOptions {
  /** See {@link IconSet.css}. */
  css?: string | undefined;
  /** Attributes every glyph's `<svg>` carries unless the glyph names its own. */
  attrs?: string | undefined;
}

/** The size a glyph is drawn at when the control does not say. */
export const DEFAULT_ICON_SIZE = 16;

/**
 * On the outermost element of every glyph drawn from the engine's built-in set — because the
 * active set had no drawing for the name, or because no set was registered at all — so a page
 * can style them, and a test can tell them from a set's own.
 */
export const ICON_FALLBACK_CLASS = "datum-icon-fallback";

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Wraps one glyph the way every SVG set draws: decorative, square, on `currentColor` by default. */
export function svgIconMarkup(glyph: SvgGlyph, options: IconRenderOptions, attrs?: string): string {
  const cls = options.className ? ` class="${escapeAttribute(options.className)}"` : "";
  const extra = glyph.attrs ?? attrs;
  const svgAttrs = extra ? ` ${extra}` : "";
  return (
    `<svg${cls} viewBox="${escapeAttribute(glyph.viewBox)}" width="${options.size}" height="${options.size}"` +
    ` aria-hidden="true" focusable="false"${svgAttrs}>${glyph.body}</svg>`
  );
}

/**
 * An icon set from SVG glyph data — a host's own drawings, or another library's path data
 * adapted to {@link SvgGlyph} (which is all the Font Awesome package is). Names left out fall
 * back to the engine's drawings.
 */
export function svgIconSet(
  id: string,
  glyphs: Partial<Record<DatumIconName, SvgGlyph>>,
  options: SvgIconSetOptions = {}
): IconSet {
  return {
    id,
    icon: (name, render) => {
      const glyph = glyphs[name];
      return glyph ? svgIconMarkup(glyph, render, options.attrs) : undefined;
    },
    css: options.css
  };
}

/**
 * An icon set from markup renderers — for a sprite (`<svg><use href="#undo"/></svg>`), an
 * icon font (`<i class="…">`), or anything else that is not path data. `css` travels into every
 * shadow root that draws the set.
 */
export function markupIconSet(
  id: string,
  render: Partial<Record<DatumIconName, (options: IconRenderOptions) => string>>,
  css?: string
): IconSet {
  return {
    id,
    icon: (name, options) => render[name]?.(options),
    css
  };
}

/** The engine's own drawings; see `builtin-icons.ts`. */
export const BUILTIN_ICONS: IconSet = svgIconSet("datum-builtin", BUILTIN_GLYPHS, { attrs: BUILTIN_ICON_ATTRS });

/**
 * One glyph from `set`, the engine's own drawing (marked {@link ICON_FALLBACK_CLASS}) when the
 * set has none — or when the set *is* the built-in one. `set` may be `undefined` for
 * "whatever the default is".
 */
export function renderIcon(
  set: IconSet | undefined,
  name: DatumIconName,
  options: Partial<IconRenderOptions> = {}
): string {
  const size = options.size ?? DEFAULT_ICON_SIZE;
  const className = options.className;
  const resolved: IconRenderOptions = className === undefined ? { size } : { size, className };
  const active = set ?? defaultIconSet();
  const own = active === BUILTIN_ICONS ? undefined : active.icon(name, resolved);
  if (own !== undefined) {
    return own;
  }
  const fallbackClass = className ? `${className} ${ICON_FALLBACK_CLASS}` : ICON_FALLBACK_CLASS;
  return BUILTIN_ICONS.icon(name, { size, className: fallbackClass }) ?? "";
}

/**
 * Where the registered default is kept: a slot on the global object rather than a module
 * variable, so a set registered through one copy of the engine — the `datum-icons-fontawesome.js`
 * bundle's, say — is seen by another on the same page (the builder bundle's), the way the web
 * components share their theme and plugin registries. One slot per page.
 */
export const DEFAULT_ICON_SET_SLOT = Symbol.for("datum.icons.default");

function iconSlot(): Record<symbol, IconSet | undefined> {
  return globalThis as unknown as Record<symbol, IconSet | undefined>;
}

/**
 * The set every element draws with unless given one of its own through its `icons` property.
 * The `datum-icons-fontawesome.js` bundle registers Font Awesome here on load;
 * the builder bundle itself registers nothing (a host that wants a library loads or imports
 * one), so a host bundling from source registers whatever it chose, or nothing and gets
 * {@link BUILTIN_ICONS}. Call it before the elements upgrade: an element already on the page
 * keeps the glyphs it drew until it repaints. `undefined` clears the registration.
 */
export function setDefaultIconSet(set: IconSet | undefined): void {
  iconSlot()[DEFAULT_ICON_SET_SLOT] = set;
}

/** The registered default, else the engine's built-in drawings. */
export function defaultIconSet(): IconSet {
  return iconSlot()[DEFAULT_ICON_SET_SLOT] ?? BUILTIN_ICONS;
}
