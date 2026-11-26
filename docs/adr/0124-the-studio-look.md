# ADR 0124: The studio look and its tokens

## Status

Accepted.

## Context

The builder is drawn in one look. A look that reads as flat white on an HDR display, with a flat bar, a strip glued to the window edge and drawers flush with the window, feels old. Keeping several builder looks, each a full copy of the token list kept in step by exact-coverage tests, is a cost for no user of the extra looks.

ADR 0099's shell has no floating chrome that depends on script-measured geometry. Any look that floats has to float without that.

The builder's shell is painted from `--db-*` custom properties. If the vocabulary were only colour, one panel radius, one shadow and one face, a theme could recolour the shell but could not make it square, thick-lined, or set its keys and labels in faces of its own: border widths, control corners, pill radii and the code face would be literals in every rule.

The builder also paints text and glyphs on `--db-accent`: pressed and selected controls, active chips, the container type tags, the primary button (`.btn.primary`), the rule-mode switch and a host's Save on the bar. If those rules paint a literal white, a builder theme whose accent is a light tone (a pastel primary in a dark scheme) gets white on a light colour, which can be 1.7:1. A theme that darkens its accent to keep white readable gives up the accent as a foreground, where it also draws focus rings, selection outlines, the dirty flag and palette icons on the panel and must read there too.

## Decision

1. **One built-in look, "studio" (light), and a dark palette.** The builder-theme seam stays: `theme`, the `--db-*` tokens, and host-registered builder themes (`builderThemes.register`). The built-in look is the only one the package ships. A page that names a builder theme nobody registered gets the built-in look and one `datum-error`, `Unknown builder theme "<id>"`, naming the ids that are registered (`themes.resolveBuilder` in `packages/datum/src/themes.ts`; reported once per id). No id is treated specially: an id is known only once a theme is registered under it (the package registers `datum-dark` itself; a page registers the rest).

   A builder theme (`BuilderThemeDefinition`, `builder/web-component/builder-theme-registry.ts`) sets the tokens inline on the builder's wrapper and its panels (`applyTheme`); `theme = undefined` reverts to the defaults printed from the one token list. A builder theme says nothing about the form the canvas draws, which is the binding's (ADR 0163).

   The dark palette (`STUDIO_DARK_TOKENS`) is a change of values only: every colour is a semantic token, and no rule mixes a literal white or black (ADR 0157).

2. **One token list.** `engine/form-engine/builder/web-component/studio-tokens.ts` holds every token as `{ name, value, tier, group, what }`, and both the shell (`wrapperStyles()`) and every panel (`builderTokens()`) print it. The values meet HDR floors and WCAG 2.2 AA, each pair measured: surfaces at least 1.15:1 apart, card outlines at least 2:1 against the card, input borders 3:1, dividers 1.5:1, text 4.5:1. The backdrop (`--db-backdrop` #EDEFF2, `--db-backdrop-dot` #D2D6DC) is decorative and holds no contrast floor.
   - **Tiers.** `public` is the contract a host or a host theme may set and rely on across versions (the seven tokens are listed in [the builder guide](../reference/builder.md), The look and its dark scheme; a test pins the list). `theme` is every other colour, type, radius, elevation, layer, motion and size value: a theme may set them, but they can change between versions.
   - **Names.** Semantic, by role and not by value: `db-surface`, `db-surface-sunken`, `db-line-card`, `db-line-input`, `db-ink-muted`, `db-selected`, `db-focus`, status `-soft` / `-line` pairs, and type, space, radius, shadow, z and motion scales. A theme sets a role, so a name outlives the value behind it.
   - **Layout values are not tokens.** The shell's layout values are set by the shell or a host's layout, never by a theme.
   - **Coverage.** Exact coverage is the contract: a test reads every `var(--db-*)` in the builder's styles and fails on a name that is neither a token nor a layout value, so a token a theme could miss fails before it ships.
   - **Forced colours and reduced motion** are part of the list's rules: system colours for every surface, line and the selection, no shadows; motion tokens 0ms under `prefers-reduced-motion`.

3. **A floating look on the shell's layout.** The bar is a row of pills on a dotted backdrop, the strip a card at the start edge, and the side panel and the inspector inset cards over the canvas (ADR 0099's drawers), every inset one constant (`--db-gap`). Every surface keeps a fixed CSS place: grid and absolute positions with constant insets, nothing measured from script. The drawer draws no frame of its own: a panel inside it draws its own cards on the backdrop (ADR 0099, decision 7).

4. **Size tiers follow the builder's own box.** The shell's wrapper is a size container (`container: db-shell / size`), so a contained builder in a short host box is Short whatever the screen. Container queries decide, never script (the width observer that sets `data-narrow` and `data-phone` is ADR 0099's decision 11 and ADR 0137's).
   - Short (under 720px of shell height) is compact density: 8px insets, 34px controls, a slimmer strip.
   - Under 1024px of shell width the workspace tabs become one native menu (ADR 0125).
   - A coarse pointer gets 44px targets.
   - The density reaches every panel through the inherited `--db-density-control-h`, which `--db-control-h` reads (a panel's own `:host` declarations would otherwise reset it).

5. **The builder's own face is Geist**, self-hosted: Geist and Geist Mono variable woff2 (SIL OFL 1.1) in `packages/datum/fonts/builder-fonts/`, copied to `dist/builder-fonts/` and linked by `<datum-form-builder load-fonts>` (`loadBuilderFonts`, resolved against the bundle's own URL, never the page's). Without the attribute the builder draws in the system face, and the design holds there too. No Google Fonts.

6. **Accessibility is part of the look.**
   - Every target is at least 24×24 (WCAG 2.5.8; 44px under a coarse pointer).
   - A 2px focus ring sits 2px outside on the light surface (`--db-focus`), a light one inside dark parts (`--db-focus-on-dark`).
   - Status is never by hue alone, headings are in sentence case, and no text is under 11px.
   - Disclosure chevrons, the document caret and the selected tick are drawn with borders, not text glyphs, so they add nothing to a name and stay crisp in any face.
   - The builder targets WCAG 2.2 AA and ATAG 2.0 Part A.

7. **A host's controls** are dressed by a light-DOM sheet at the weight of one element, with no `::slotted` (ADR 0118, decision 3). A host marks its primary action with `data-builder-primary` to get the accent pill.

8. **CSS in the bundle is stripped.** The build strips comments and indentation from the engine's CSS template literals (`packages/datum/scripts/strip-css-literals.ts`, on the source through the TypeScript parser, never on bundle text). A comment in builder CSS is therefore free, and must not contain a backtick.

9. **Proof in a browser.** `npm run builder:browser` (packages/datum) captures the builder at each size tier in each state, runs axe, walks the Tab order and times keystrokes and commits, against a committed baseline.

10. **Geometry and type are tokens beside colour.** The list declares `--db-border-w` (default `1px`) for every chrome border that reads a `--db-*` colour, `--db-radius-sm` and the other radius steps for the control corners (one value per role instead of a mix of literals), `--db-radius-pill` (default `999px`) for the pills (counts, tags, chips, locale flags), and `--db-font-mono` for keys and code everywhere the builder sets a face for code. The builder reads these tokens for these properties; a rule that wants a different weight or corner must say why, since a theme cannot follow a literal.

11. **Selection feedback stays literal on purpose.** The `2px solid` selection outline, the `1px dashed` hover and drop-zone outlines, and the accent bar on a pending translation are the builder telling the author what is selected, not chrome a theme dresses.

12. **`--db-accent-ink` is the colour of anything painted on the accent.** It is a `public`-tier token beside `--db-accent` (default `#fff` in the light look, `#0f1114` in the dark one), and every rule that paints text or an icon on the accent reads it. A test refuses a literal white next to an accent background in the builder's styles.

13. **The accent and its ink are held at 4.5:1.** The ink is text, so the floor is WCAG 1.4.3's 4.5:1, not the 3:1 non-text floor. A test holds the default look's accent and ink at that ratio, and the dark look's palette is drawn to the same floor. A theme that sets its accent sets its ink with it; a theme that leaves the ink unset keeps white.

14. **The accent is not moved for its ink.** It is also a foreground on the surfaces, so a theme picks the accent where it reads there, and the ink to the side (dark or light) of it where black or white holds more contrast.

## Reasoning

- **Geometry as properties.** A theme that wants square corners, thick lines or a display face for micro-headings needs those as properties; otherwise the only themes possible are recolourings. The defaults are the stock look's values, so a theme that leaves them unset changes nothing.
- **A separate ink token.** One accent can then serve both jobs. The alternative, one accent chosen to carry white and read as text on the panel, has no solution for light accents, and every dark scheme wants one.

## Consequences

- One look to maintain. A host that wants another registers a builder theme against the public tier, or the full theme tier at its own risk.
- Token names are the look's public interface: a host theme sets them by name, so a change to a name reaches every host.
- The look depends on `load-fonts` for its face; hosts that leave it off see the system face.
- Any builder theme controls border weight, corner treatment and the code face, and owns the ink on its accent. A host theme with a light accent sets a dark ink.
- How a toolbar takes the keyboard and when the builder asks before acting are the shell's interaction patterns, ADR 0179.
