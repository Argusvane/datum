# ADR 0048: Pluggable icon sets; Font Awesome as a package

## Status
Accepted.

## Context

The engine's own chrome (the builder shell's strip items, the canvas toolbar, the component
palette, the drag grips on the canvas, and `<datum-form-host>`'s Validate / Print / PDF row)
needs icons. Hard-wiring an icon library into the engine would make every host, the embeddable
bundles and anyone bundling from source, ship that library whether they wanted it
or not, together with its attribution. A host that already has an icon system (Material
Symbols, Lucide, its own sprite) must be able to make the builder match it, and one that must
avoid a given library must be able to leave it out.

## Decision

1. **The chrome draws icons by name through an icon-set contract.**
   `render/icons/icon-set.ts` defines `IconSet { id; icon(name, { size, className }); css? }`
   and the engine's vocabulary `DATUM_ICON_NAMES` (`render/icons/icon-names.ts`): chrome names,
   each one control (the bar, the activity strip, the canvas toolbar, the form host's Validate /
   Print / PDF row), and palette names, one per kind of component, with `component` for a type
   nothing names. Names say where a glyph
   goes, not what it looks like, so a host mapping its own library knows what each is for. The
   table from component *types* to palette names (`paletteGlyphName` in `builder-shared.ts`,
   with vendor-prefix tail matching: `gcds-link` → `content-link`, `tel` → `field-phone`) is the
   engine's, so a set never sees a host's type names. Every shipped set draws every name the
   chrome uses.

2. **Resolution is at render time, never at import.** `renderIcon(set, name, options)` is
   called when the control that shows the glyph is drawn. The canvas toolbar, the rails'
   reopen buttons and the host's action row wrap each glyph in a slot (`[data-glyph]`) they
   repaint in place when their set changes; the palette and the drag grips are drawn afresh on
   every repaint anyway.

   `IconSet.css` is written into a `<style data-icon-css>` in every
   shadow root that draws the set (the builder panels, the shell, the host, and the canvas's
   renderer through `extraStyles`, since the grips are drawn inside it) for an icon font's
   class rules or a sprite's sizing; the font file itself is the page's to load, as an
   `@font-face` declared in the document applies inside shadow roots.

3. **A partial set is a complete set.** A set returns `undefined` for a name it does not draw
   and the engine draws its own glyph, marked `datum-icon-fallback`. The engine's drawings
   (`BUILTIN_ICONS`, `render/icons/builtin-icons.ts`) are hand-traced 24×24 stroke SVGs on
   `currentColor`, in the style the GC Design System components use for their icon vocabulary:
   - One per chrome name.
   - One per palette *kind* (an input box, a cursor, a framed box, text
     lines, a cube) that the palette names collapse onto.

   The form's bundle carries that set and
   never draws a palette, so the drawing per palette name is the builder's own
   (`builder/web-component/palette-glyphs.ts`): the palette draws it for any name the page's
   set leaves out, so a rail of fields reads as different fields with no icon library on the page. No library, no webfont, no dependency.

4. **The default is registered, per page, or given per element.** `setDefaultIconSet(set)` /
   `defaultIconSet()` hold a default the way `registerRenderModeAdapter` holds the render-mode
   adapters (ADR 0045); unset, it is `BUILTIN_ICONS`. `DatumBuilderOptions.icons` (forwarded by
   the shell to its panels, whichever mode is on the page) and `<datum-form-host>.icons`
   override it per element; `<datum-form-builder>.icons` forwards to the builder. Registering
   after an element has drawn does not repaint it: register before the elements upgrade, or set
   `icons` on the element, which does. The engine keeps the registered default on the page
   (`globalThis[Symbol.for("datum.icons.default")]`, `DEFAULT_ICON_SET_SLOT`), so a set
   registered through one copy of the engine is read by another.

5. **Font Awesome is a package, not an engine dependency.** `plugins/icons-fontawesome`
   exports `FONT_AWESOME_ICONS`, an `svgIconSet` over one Free-solid definition per name. It
   reaches a page as the opt-in `datum-icons-fontawesome` bundle, which registers it on load;
   neither `datum-builder.js` nor `datum-form.js` carries it. `datum-builder.js` imports no icon
   library and registers nothing: without a registered set the chrome draws with `BUILTIN_ICONS`.
   A page loads the bundle *before* the builder script, since the default is read as the elements
   upgrade, or sets `builder.icons` on an element already drawn. `@argusvane/datum-engine` has no
   `@fortawesome/` dependency, and `check-architecture-boundaries.mjs` fails on any
   `@fortawesome/` import under `form-engine/`.

6. **A set's markup is trusted; a form's text glyph is not.** An icon set is the page author's,
   written into shadow roots as-is like a binding's `css`. `BuilderComponentType.icon`
   (data from a component catalogue) stays escaped as text, and the palette's built-in glyphs
   are chosen from the engine's own vocabulary, so nothing a form or a catalogue says can inject
   markup.

7. **Two helpers cover the common shapes; the interface covers the rest.**
   `svgIconSet(id, glyphs, { attrs?, css? })` for path data (`SvgGlyph { viewBox, body, attrs? }`),
   which is all the Font Awesome package is; `markupIconSet(id, renderers, css?)` for a sprite's
   `<use>` or an icon font's `<i class>`; an object implementing `IconSet` directly for anything
   else. `DATUM_ICON_NAMES` and `isDatumIconName` are exported so a set can be checked for
   coverage. `docs/reference/embedding.md` (Icons) has a worked set.

## Consequences

- The engine depends on no icon library; the drawing is chosen at render, from a set the page
  chose.
- A host's own icons can replace every glyph in the chrome, not one or two text characters per
  palette entry.
- Icon sets are a direct option like `pdfProvider`, not a `FormPlugin`
  contribution (ADR 0001).
- The PDF designer's palette keeps its text glyphs (`render/pdf/pdf-components.ts`).
- `plugins/icons-fontawesome` builds its own bundle (ADR 0095), so the set cannot reach the builder
  or renderer bundles.
