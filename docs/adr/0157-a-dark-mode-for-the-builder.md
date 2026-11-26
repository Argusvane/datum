# ADR 0157: A dark mode for the builder

## Status

Accepted.

## Context

The studio look (ADR 0124) is one light palette, printed as `--db-*` defaults on the shell's root and every panel's. A host can register a builder theme of its own (`builderThemes.register`), and the shell applies a theme's tokens inline on the wrap and each panel host, since a panel's own `:host` defaults beat an inherited value. Without a shipped dark palette, a dark builder needs a host to draw one, and nothing on the bar lets a person ask for it.

## Decision

1. **The dark palette is the studio look's own, in the same token list.** `STUDIO_DARK_TOKENS` redraws every colour and elevation token for a dark page and nothing else: type, space, radius, layers and motion stay the light look's, so the two are one look. The token `db-color-scheme` (light | dark) feeds `color-scheme` on every builder root (`studioTokenRules()`), so the native parts a stylesheet cannot reach (scrollbars, select popups, date pickers) follow. The selection inverts: the light look's near-black pill is the ink on the dark page, with the light accent as the ring inside it. The dark palette lives in a module of its own (`studio-dark-theme.ts`), apart from the studio token list, so the shared registry can register the theme in every bundle without carrying the token descriptions.

2. **Floors, measured on the dark surface (`#1e2127`).** Surfaces at least 1.15:1 apart, card outlines 2:1, input lines 3:1, dividers 1.5:1, text 4.5:1, the accent as a fill under its dark ink and as text, and the state colours on their washes at 4.5:1 or better. `engine/tests/builder-default-tokens.test.ts` holds every pair, as it holds the light look's list.

3. **It is a builder theme.** `DATUM_DARK_BUILDER_THEME` (id `datum-dark`, target `builder`, `builder/web-component/studio-dark-theme.ts`) is registered by `@argusvane/datum` in the page's builder theme registry, so `<datum-form-builder theme="datum-dark">` names it.

4. **`scheme` is the switch.** The shell (`DefaultBuilderElement`) has a `scheme` attribute and property (`"light"` | `"dark"`). Dark applies the dark theme's tokens through the same path a host theme takes (`applyTheme`, inline on the wrap and every panel host), layered over any host `theme`: every colour is the dark one, the host's type, space and radii stay. The tokens reach every host that declares the defaults on itself, the lazy Logic, Data, Languages and overview surfaces and the command palette included, whether made before or after the switch. Light is the host's theme or the built-in look. `builder-scheme-change` reports a change; `<datum-form-builder>` forwards the attribute, reflects the change and re-emits it as `datum-builder-scheme-change`, as it does full-window.

5. **A host `theme="datum-dark"` is the dark scheme by default.** Without a `scheme` attribute and without a remembered choice the shell reports `"dark"` for it and the switch offers Light mode; a remembered choice (light or dark) wins over the host theme, which is only the default. `scheme="light"` over it shows the built-in look, the dark theme's light half.

6. **The menu on the bar holds Dark mode.** The bar's menu button is named "Menu" (`shell.file.menu`), since it holds Dark mode as well as the file items (ADR 0118). The item sits at the menu's foot and names the scheme it switches to: "Dark mode" under a moon while light is on, "Light mode" under a sun while dark is on. The same row sits under Tools in the phone drawer. Choosing it writes the choice under `localStorage` (`datum-builder:scheme`, one record per origin: the preference is the person's, not a page's); a shell connecting without a `scheme` attribute reads it back, and a page that sets the attribute decides for itself. Remembering the scheme does not depend on `persist-panels`: ADR 0099 keeps the scheme out of the layout record. `no-scheme-toggle` takes the switch off both menus; `scheme` still sets the look.

7. **The menu stays on the bar.** With Dark mode in it, the menu shows even when the host supplies no file action (`file-actions="off"` included); the file items alone come and go.

8. **`<datum-form-builder>` reflects the inner scheme.** A remembered dark scheme shows on its `scheme` attribute once the inner builder connects, with no event; removing the attribute hands the choice back to the memory rather than snapping to light; and while dark the wrapper's own host carries `color-scheme` and the few `--db-*` tokens its shadow root reads (the chunk status card, the Download notice, an assistant's banner).

9. **The form on the canvas follows the scheme where its binding can.** While the builder is dark, the canvas, and Try it on it, draw the `datum` binding in its dark look (the canvas's colour scheme is dark, `BuilderController.canvasColorScheme()`).

   A design-system binding may name a dark counterpart (`LiveBinding.darkVariant`, the id of another registered binding); while the builder is dark the canvas draws with that variant (`BuilderController.canvasBinding()`), looked up among the bindings the picker offers, else the page's registry. The choice stays the author's: nothing is written into the form, and `builder-binding-change` reports the pick alone.

   The View panel's binding picker (shown when the host offers more than one binding and the `binding-picker` feature is on, ADR 0143) names what the canvas draws (`BuilderController.bindingChoices()`): in a dark builder a binding reads under its dark variant's name, and the variant's own entry is left out, since the two would draw the same form. The sheet takes the surface of the binding it is drawn with (ADR 0163), so a binding with no dark look stays a light form on a white sheet on the dark desk.

## Reasoning

- **The same token list, a second palette.** One look in two palettes keeps type, space, radius and motion consistent and makes the dark palette testable against the same floors.
- **A switch that names its destination.** A switch that kept saying "Dark mode" while dark was on read as stuck, so the item names the scheme it switches to, as the full-window item names its other state.
- **One scheme on the screen.** A white sheet in a dark builder is the brightest thing on the page and the reason a person switches to dark in the first place, so the form follows where a dark version of its binding exists. The variant is named by the binding, not guessed from an id, so the engine knows no binding package, and a light-only design system is never recoloured.
- **The preference is the person's.** It is remembered per origin, so a page that sets the attribute is the only thing that overrides it.

## Consequences

- The light look's tokens, tiers and public contract are unchanged; a host theme still applies as before, and is what light mode shows when one is set.
- The form's own dark look is the `datum` binding's dark token set (ADR 0163); the builder's `datum-dark` builder theme (`STUDIO_DARK_TOKENS`) is a separate palette for the shell.
