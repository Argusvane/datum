# Customising the builder

A host that embeds `<datum-form-builder>` in its own application decides what the author sees:

- Where the builder opens.
- Which settings the host owns.
- How the builder looks.
- What the page adds to it.

Everything here is set on the element or from the page's script.

- Taking parts away is on [Leaving parts out](/leaving-parts-out).
- Loading, sizing, methods, events and saving are on [The builder element](/builder-element).

## Where the builder opens

Which parts exist, which workspaces and panels show, and which component types the palette offers are set with `features` and its narrower switches. [Leaving parts out](/leaving-parts-out#the-builder) maps each goal to the one setting that does it. This section is only about where the builder opens.

The builder has seven workspaces: `form`, `logic`, `data`, `languages`, `journeys`, `pdf` and `print`. Use `workspace` to say which one opens first, and `setWorkspace("logic")` to move to another from the page. Two things can override it:

- A workspace the author remembered under `persist-panels` wins over the attribute.
- A workspace that `features` leaves out is refused: the form opens instead.

`mode` is the same choice at a lower level: the three designers (`form`, `pdf` and `journeys`), where `workspace="pdf"` and `mode="pdf"` open the same place. It is kept for hosts that already use it.

A move to PDF or Journeys can raise `datum-builder-mode-change` as well as `datum-builder-workspace-change`, so a host that listens should listen to the workspace event alone.

```html
<datum-form-builder
  features="minimal logic languages"
  workspace="logic"
  hidden-panels="chrome tests"
  component-types="text,select,-acme-*"
></datum-form-builder>
```

### Settings the host owns

`managed-settings` takes a list of inspector property paths, separated by spaces or commas. For each one:

- The inspector shows "Managed by the site." in place of the control and never changes the stored value.
- The component's JSON editor refuses text that would change it.

Use it for a setting your application fixes itself.

```html
<datum-form-builder managed-settings="required data.answersFree agentTools"></datum-form-builder>
```

A path is one of these:

- The setting's key in the component's `configuration` for a component, such as `required`, `label` or `description`.
- Its key in the root configuration for a form-wide setting, such as `chrome.frame` or `messages`.

Two shorthands:

- `answersFree` is short for `data.answersFree`.
- `agentTools` locks the form's choice about assistant tools.

To find another path, open the component's JSON and read the key.

## Full window

`full-window` makes the builder cover the whole browser window, and the bar's button toggles it. `no-full-window` removes that button. The builder fires `datum-builder-full-window-change` when it opens or closes.

## Look and dark scheme

| Attribute | Takes | Notes |
|---|---|---|
| `theme` | `default`, `datum-dark`, or a registered id | The builder's own look. An unknown id keeps the built-in look and raises `datum-error`. |
| `scheme` | `light`, `dark` | The colour scheme. Left out, the one the author last chose on this origin applies. |
| `no-scheme-toggle` | boolean | Removes Dark mode from the ⋮ menu. `scheme` still sets the look. |
| `load-fonts` | boolean | Loads the builder's own faces, Geist and Geist Mono, from beside the bundle. Without it the builder uses the system face. |
| `persist-panels` | storage key | Remembers the open panel, the column widths, whether the inspector is folded and the workspace (Form, Logic, Data, Languages or Print; Journeys and PDF are never put back), under that key in the browser's local storage, or for this page load alone when storage is blocked. An empty attribute uses the key `default`. Builders on one origin that share a key share their layout. |
| `layout` | `page`, `contained` | `contained` fills the element's box; set `--db-shell-top` to the height of a header that stays above a `page` builder. |

A host registers its own builder theme before the element connects, then names it:

```js
import { builderThemes } from "./datum-builder.js";

builderThemes.register({
  id: "acme",
  version: "1.0.0",
  target: "builder",
  tokens: {
    "db-accent": "#0b5fff",
    "db-accent-hover": "#0a4fd6",
    "db-accent-ink": "#ffffff",
    "db-accent-text": "#0a4fd6",
    "db-accent-soft": "#e3ecff"
  }
});
```

```html
<datum-form-builder theme="acme"></datum-form-builder>
```

A page that loads `datum-builder.iife.js` as a classic script has no `import`: everything the module exports is on `window.DatumBuilder`, so the call is `DatumBuilder.builderThemes.register({ … })`, and an icon set is set with `DatumBuilder.setDefaultIconSet(…)`.

`tokens` maps builder token names (`db-surface`, with or without the leading `--`) to values. Tokens a theme leaves out keep the built-in look. `extends` names a theme already registered, such as `datum-dark`, to build on instead.

Seven tokens are the contract, and stay across versions:

- `db-accent`
- `db-accent-hover`
- `db-accent-ink`: text and icons on the accent.
- `db-accent-text`: the accent as text.
- `db-accent-soft`: selected rows and badges.
- `db-font` and `db-font-mono`: the two faces.

The first five are the accent set. A theme that sets the accent should set all five, as above, or hover and selected rows keep the built-in blue.

The other colour, type, radius and elevation tokens can be set too, but they may change between versions. The sizes of the layout (the bar height, the widths of the rail and drawers, the gaps) belong to the builder: do not set them.

## The command palette

Ctrl+K (Cmd+K on a Mac) inside the builder, or the search button on its bar, opens a list of every command: workspaces, components to add or go to, edits on the selection, documents and views. `openPalette()` opens it from the page. `registerCommands()` adds the page's own commands, read each time the palette opens, and returns a function that takes them out.

```js
const off = builder.registerCommands({
  commands: () => [{
    id: "acme:publish",
    label: "Publish to production",
    group: "host",
    keywords: ["release"],
    shortcut: "Ctrl+Shift+P",
    enabled: () => builder.dirty === false,
    run: () => publish(builder.definition)
  }]
});
```

A command has these fields:

- `id`
- `label`
- `group`: the palette's own groups are `workspaces`, `add`, `go to`, `edit`, `documents` and `view`, so a command from the page belongs to `host`.
- `keywords`: optional; the search matches them beside the label.
- `shortcut`: optional; it is shown beside the command and is never bound, so bind the key yourself.
- `enabled`: an optional function; it returns `false` to grey the command and skip it.
- `run`: a function.

## Driving the builder from the page

The methods are listed on [The builder element](/builder-element#methods): `setWorkspace()`, `setMode()`, `undo()`, `redo()`, `hasUnsavedChanges()`, `requestLeave()`, `markSaved()` and the rest. Two notes belong here:

- `hasUnsavedChanges()` is true only while an edit is held outside the form, such as an inspector change not yet applied. The `dirty` property is the one that reports whether the definition differs from the saved one, so gate a Save button or a navigation on `dirty`.
- Set attributes such as `workspace` before the element connects: a method called straight after `createElement` has nothing to act on.

## Slots

The bar has places for the page's own controls, drawn in the builder's look:

- `toolbar-start`, `toolbar` and `canvas-actions`.
- `history`, `comments`, `publish` and `account`, each drawn only when filled.

Mark the main action with `data-builder-primary` for the accent pill.

```html
<datum-form-builder src="/forms/intake.json">
  <button slot="toolbar-start">Preview on site</button>
  <button slot="publish" data-builder-primary>Publish</button>
</datum-form-builder>
```

### A panel of your own

The activity strip down the side takes a button in the `strip` slot and the panel it opens in the `panel` slot. Give both the same `data-panel` id, or the button opens nothing. Add `data-workspace="data"` to the button to show it in that workspace only.

```html
<datum-form-builder src="/forms/intake.json">
  <button slot="strip" data-panel="acme-help" data-workspace="form">Help</button>
  <section slot="panel" data-panel="acme-help">
    <h2>Acme help</h2>
    <p>Our field naming rules.</p>
  </section>
</datum-form-builder>
```

## Icons

The builder draws its icons through an icon set. The `icons` property takes one for this builder, and `setDefaultIconSet()` sets it for the page. A set that leaves a name out gets the builder's own drawing for it.

The builder's own icons are strokes drawn without a library behind them. `datum-icons-fontawesome.js` is a bundle that registers Font Awesome Free's solid glyphs as the page's icon set.

- Load it before `datum-builder.js`, since the builder reads the set when it draws.
- The bundle also exports the set as `FONT_AWESOME_ICONS`, for a page that gives it to one builder with `builder.icons`.

Switch the example to the builder's own icons to see what changes.

<LiveExample name="icons-fontawesome" />

A set of your own is one object with an `id` and an `icon(name, { size, className })` function that returns markup for a name, or nothing for a name it has no drawing for.

- `svgIconSet` builds one from SVG glyph data.
- `markupIconSet` builds one from any markup, such as an icon font's class or a sprite's `<use>`.
- The names are listed in `DATUM_ICON_NAMES`.

The example below draws a few of them itself and leaves the rest to the builder. A library such as Lucide or Material Symbols plugs in the same way, with one glyph per name taken from the library's own data.

<LiveExample name="icons-library" />

Both pages draw the whole builder, so press the builder's **Full window** button (the arrows on its bar) to see the palette and the bar at their full size.

## Events

The events are listed on [The builder element](/builder-element#events). A host that enables a Save button from its own state listens to `datum-builder-dirty-change` and reads `dirty`:

```js
builder.addEventListener("datum-builder-dirty-change", () => {
  saveButton.disabled = !builder.dirty;
});
```
