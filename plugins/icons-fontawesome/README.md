# @argusvane/datum-icons-fontawesome

Font Awesome Free's solid glyphs as an `IconSet` for the engine's chrome (ADR 0048): one
glyph per name in the engine's icon vocabulary, adapted from `@fortawesome/free-solid-svg-icons`
path data with `svgIconSet`, so nothing is a webfont and every glyph is inline SVG on
`currentColor`.

Nothing bundles it (ADR 0048): the builder bundle draws with the engine's own drawings unless
the page registers a set. A page loads `dist/datum-icons-fontawesome.js` *before*
`datum-builder.js` — the default set is read as the elements upgrade — or sets
`builder.icons = FONT_AWESOME_ICONS` on an element already drawn:

```html
<script type="module" src="/datum/datum-icons-fontawesome.js"></script>
<script type="module" src="/datum/datum-builder.js"></script>
```

A host bundling from source registers the package itself, once, before the first element
upgrades:

```ts
import { setDefaultIconSet } from "@argusvane/datum-engine";
import { FONT_AWESOME_ICONS } from "@argusvane/datum-icons-fontawesome";
setDefaultIconSet(FONT_AWESOME_ICONS);
```

The registered default lives on the page (`globalThis[Symbol.for("datum.icons.default")]`),
not in any one bundle's copy of the engine, so a registration made by one bundle is seen by
another. `FONT_AWESOME_GLYPHS` is the name → icon table, `fontAwesomeGlyph(def)` the
adapter for one Font Awesome icon definition, for a host that swaps a glyph or adds a name.

## Licence

The glyph paths are Font Awesome Free's: icons under CC BY 4.0, code under MIT, Copyright Fonticons, Inc.
The bundle keeps Font Awesome's licence banner inside the file, and `dist/` carries the licence text beside
it (`datum-icons-fontawesome.LICENSE.txt`, and the package's own file unchanged as
`LICENSE.fortawesome__free-solid-svg-icons.txt`). A host that republishes the bundle keeps those files with it.
