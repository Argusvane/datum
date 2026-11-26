# Embedding the builder

`<datum-form-builder>` is the whole builder as one element: the palette, the canvas, the inspector and the workspaces beside them. An application places it in its own shell, hands it a form and stores what comes back.

## The whole page

<LiveExample name="builder" />

The builder needs room. Measured on the builder's own width:

- Under 900 pixels the side panels become drawers.
- Under 768 it takes a phone layout with a bar along its bottom holding the palette, the outline and the rest.

So on a wide window the result runs past the text column, into the place of the page outline, which steps aside while the builder is on screen. Press the builder's **Full window** button (the arrows on its bar) for the builder at the full size of the window.

## Sizing it

- `layout="contained"` keeps the builder's bar and rails inside the box the page gives it, so the page sets a height.
- `layout="page"` takes the viewport instead, for a page that is only the builder.

Under a header of the application's own, set `--db-shell-top` to the header's height so the builder starts below it.

## Handing it a form

`src` fetches a definition, and the `definition` property takes the object. With neither, the builder opens on a new form, which holds a Submit button and nothing else.

`dataSources` takes the same sources the rendering page will supply. The builder never stores them: the canvas previews their options and the inspector offers their ids.

## New, Open and Download

The bar leads with the builder's own file actions, over the whole definition as a JSON file.

- Each asks before it replaces unsaved work and is reported as `datum-builder-file-action` once it is done.
- `file-actions` picks which show: a list such as `"open download"`, or `"off"` for none.
- The `fileActions` property takes the page's own function for any of them.

## The page's controls on the bar

A control with `slot="toolbar"` rides the builder's bar, drawn in the builder's look. Mark the main one with `data-builder-primary` for the accent. The other places on the bar are listed in [Customising the builder](/customising-the-builder).

## Hearing every edit

`datum-builder-change` fires on every edit with the whole form in `detail.definition`, ready to store or to hand straight to a `<datum-form>` on the same page for a live preview. The builder emits what the form takes, so one line sits between them.

<LiveExample name="together" />

Edit a component in the builder and the form under it follows. In the column the builder takes its small-screen layout, so press the builder's **Full window** button (the arrows on its bar) to work in it at the full width of the window, then press it again to see the form.

## Saving

The first example saves with one attribute, `save="/api/forms/customer-intake"`.

1. Make an edit and the builder shows "Changes not saved" on its bar.
2. Choose **Save** from the ⋮ menu, or press Ctrl/Cmd+S in the builder, and the log shows the `PUT` the builder sent.
3. A 2xx answer clears the cue.

Use **Server reply to Save** to see a refusal or an unreachable server, which show beside the menu as the reason the form was not saved.

That is the simplest of several ways. [Saving forms](/saving-forms) chooses between them, and covers what the builder does when the person leaves with unsaved work.

### A server that checks the revision

A page that keeps its forms on a server usually needs a request the attributes cannot make, such as one that carries the revision the form was loaded at. For that, hand the builder a function: `builder.fileActions = { save, saveLabel }` puts Save in the ⋮ menu and on Ctrl/Cmd+S. The builder then:

- Asks about an open edit.
- Shows "Saving…" while the promise is pending.
- Shows the message of a rejection beside the menu.

<LiveExample name="builder-save" />

1. Make an edit and the builder shows "Changes not saved" on its bar.
2. Choose **Save** from the ⋮ menu, or press Ctrl/Cmd+S in the builder, and the log shows the `PUT` with its `If-Match` revision and the cue clears.
3. Turn on **Someone else saves first** and save again: the server has moved on, the `PUT` is refused with 409 and the page throws, which is what shows beside the menu.

The function sets `savedDefinition` to the form it sent, not to whatever the builder holds when the answer arrives, so an edit made during the save stays unsaved.

## Trying the server's checks in the browser

A server judges a submission with the validation sandbox, a WebAssembly program. The builder can run that same program in the page, so an author sees the verdict a submission would get before there is a server to send one to. In Try it, the author turns on **WebAssembly validation**, and the checks then run on both sides: the browser's as the person meets them, and the sandbox's as the server would answer.

It is on by default and costs nothing until it is used:

- The builder looks for the sandbox module, `datum-wasm.js`, beside its own bundle.
- It fetches the module only when an author first turns the validator on.
- If the file is not there, Try it says so and checks in the browser alone.

| `wasm` | Does |
|---|---|
| absent or `auto` | Uses `datum-wasm.js` beside the builder's bundle |
| a URL | Uses the module at that address. A URL on another origin is refused unless `allow-origins` lists it |
| `off` | No sandbox. Try it checks in the browser alone |

```html
<datum-form-builder src="/forms/intake.json" wasm="/assets/datum-wasm.js"></datum-form-builder>
```

What the run is given, so that it answers as a server would:

- **The form as it stands**, unsaved edits included, with its translations.
- **The answers typed in Try it.**
- **The rule modules of the page's plugins.** A plugin's `wasmPlugin` is loaded into the sandbox, so its validators and formula functions judge here as they do on the server. See [Plugins](/plugins).
- **The host values** the author set in the Settings panel, for rules that read `host.`.

The sandbox cannot reach the network, the file system or the clock, here as on a server. It runs the checks the sandbox owns. Two things are not part of it:

- A host validator that needs your own database.
- The limits and hooks a real host adds.

See [Validation and the sandbox](/validation) for which check runs where.

### Checks of your own

To have Try it ask something else, such as your real server, give the builder a `serverChecks` object. It wins over `wasm`.

```js
builder.serverChecks = {
  label: "Intake service",
  async run({ root, answers, locale, kinds, hostContext }) {
    const response = await fetch("/api/try", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ root, answers, locale, kinds, hostContext }) });
    return { errors: (await response.json()).errors };
  }
};
```

- `label` names the checks in the Try it panel.
- `run` receives the form's root component, the answers, the locale, the form's `kinds` map when it uses a plugin's or a binding's component type, and the host values when the author gave any.
- `run` resolves with `{ errors }`, each error shaped as the sandbox's own.

## Next

- Which workspaces, panels and component types show, and the builder's look: [Customising the builder](/customising-the-builder).
- A builder with only the parts you list: [Leaving parts out](/leaving-parts-out).
- Every attribute, property, event and method: [The builder element](/builder-element).
