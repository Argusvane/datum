# ADR 0100: A command palette for the builder

## Status

Accepted.

## Context

The builder's chrome is kept small on purpose: one bar, an activity strip that opens one panel at a time, workspaces, a docked inspector (ADR 0099, ADR 0125). Fewer controls on screen also means some actions sit two clicks deep, behind a strip panel, the canvas's selection bar or a menu. An author who knows what they want ("add a date field", "go to the country field", "go to the Logic workspace", "open the letter layout") has to find the control that does it.

The same shell has to serve keyboard users. The builder's actions are reachable by keyboard but are not listed anywhere, so there is no one place a screen reader user can read what the builder can do and do it. A command palette, the Cmd+K / Ctrl+K launcher of VS Code, Figma, Linear and Notion, answers both: one shortcut opens a text box, typing filters every action, Enter runs the highlighted one.

The pieces a palette runs over are already enumerable. `BuilderController` centralises every mutation (ADR 0001) and lists what can be added (`componentTypes()`) and every node (`treeView()`). A `BuilderMode` lists its documents. The shell owns the workspaces, the strip's panels and the bar's own controls.

## Decision

1. **One overlay, one shortcut.** `<datum-builder-palette>` is a `<dialog>` in the shell's shadow root, centred under the top of the builder (a bottom sheet on a phone, ADR 0137), themed with the existing `--db-*` tokens. It opens on Cmd+K (macOS) / Ctrl+K (elsewhere) when the event happens inside the shell, on the bar's search button (`[data-palette-open]`, after undo and redo), and on `builder.openPalette()`. Escape, a click on the backdrop, or running a command closes it, and focus returns to where it was. The `palette` feature (ADR 0143) gates all three: without it the key is the page's and `openPalette()` does nothing.

2. **Its own chunk.** The element (`builder/palette/command-palette.ts`) and its English (`palette-texts-en.ts`) load the first time the palette opens (`palette-loader.ts`), and a failed load is tried again on the next open. The commands and their ranking (`palette-filter.ts`: `BuilderCommand`, `rankCommands`) are pure and stay in the entry.

3. **A command registry the shell derives.** A command is a plain record (`BuilderCommand`: `id`, `label`, `group`, optional `keywords`, `shortcut` and `enabled`, and `run`), and the shell builds the list each time the palette opens (`paletteCommands`) from what it already knows: the workspaces, the active controller's component types and tree, the edits on the selection, each mode's documents, and the views. The selection's actions run the canvas's own (`canvas.runAction`), so Delete's confirmation is kept. A host adds commands through `registerCommands(source)` (on `<datum-builder>`, forwarded by `<datum-form-builder>`), which returns the way to take the source out; a source that throws is logged and left out. The groups, their order and the commands in each are in [the builder guide](../reference/builder.md) (The command palette).

4. **Filtering is a subsequence match, ranked.** Word-start hits come first, then a label hit over a keyword hit and a tight span over a loose one, then group order. A disabled command stays listed after the enabled ones of its rank. An empty query lists the last five commands run, then every group. The input is a `role="combobox"` over a `role="listbox"` with a roving highlight, so Up, Down, Home, End and Enter work from the box and Tab is held in it, and the count of matches is announced through a polite live region.

5. **Nothing runs that the UI would not.** Every command calls the same guarded controller, mode or shell method its control calls, so a dirty draft still prompts, a fixed widget still refuses deletion, and a busy activation still shows busy. The palette adds no second path. The palette closes before the command runs, so a prompt or menu the command opens never sits under it.

## Consequences

- Every action the builder offers is reachable in a few keystrokes from anywhere in the shell and readable as a list by assistive technology, without adding a control to the bar beyond one button.
- The registry is derived, not hand-kept: a new component type, node, document or workspace appears in the palette with no palette change. Host commands are the only ones registered by hand.
- Cmd+K / Ctrl+K may already be bound by a host page. The shell handles the key only when the event's target is inside the shell, and a host that wants the key for itself leaves the `palette` feature off.
