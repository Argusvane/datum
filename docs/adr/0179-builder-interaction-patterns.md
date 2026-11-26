# ADR 0179: Builder interaction patterns: toolbars, confirmations, dialogs and leaving

## Status

Accepted.

## Context

The builder has many bars, prompts and editors. Built one at a time, each would choose its own keys, its own way of asking and its own idea of where a dialog sits. Four patterns are shared across the shell and its surfaces, and each is a decision about how one kind of thing is done everywhere: a bar of tools, a question before an action, a dialog inside an embedded page, and a page that is about to go.

## Decision

### 1. A toolbar is one Tab stop

Every bar of tools (`role="toolbar"`: the canvas bar, the selection bar, the journey map's bar and its selected step's bar, Print's toolbar) follows the ARIA toolbar pattern, horizontally, through one helper, `rovingToolbar(bar, selector?, watchSize?)` in `web-component/toolbar-roving.ts`.

- **Keys.** Left and Right move between the tools in the direction the bar reads, wrapping, and Home and End go to the ends. Keys typed in a text box inside a bar are left to the box.
- **Skipped tools.** A tool that is hidden (by an attribute or by CSS, as in a folded card or behind a container query) or disabled is skipped. An `aria-disabled` tool stays reachable.
- **The Tab stop.** It stays on the tool last focused while that tool still shows, else on the first that does. A bar with nothing showing yet keeps the stop it had.
- **When it is put right.** When a tool is added or removed, when its `hidden` or `disabled` attribute changes, and when a tool takes focus; for a bar whose tools a container query folds (the canvas bar), also when the bar changes size and when its `⋯` card is put away. A tool hidden by CSS alone is skipped from the next of those on.
- **Folded tools.** A tool folded into a card (the canvas's `⋯`) is reached by opening the card, which takes focus to its first tool.
- **Tabs.** The workspace tabs are a tablist with the same keys.
- **The component rail.** The add rail over the strip is a vertical toolbar and roves with its own code, not this helper: Up and Down move between its buttons (wrapping), Home and End go to the ends, and one button holds the Tab stop.

### 2. A modal dialog for what Undo cannot restore or where a choice is needed first; an inline note for an undoable removal; nothing for a small undoable edit

- **What Undo cannot restore.** The action asks in a modal `dialog.db-confirm` (`role="alertdialog"`, opened as decision 3 says): New and Open, which replace the document (ADR 0118), and discarding unapplied edits (the unsaved-changes prompt, the options editor's Discard).
- **A choice needed first.** So does an action that needs a choice before it runs: deleting a component, whose dialog lists what else in the form names it and offers to remove those references too (and which can be reached by accident from the canvas's hover chrome), and a journey step deleted from the map, through the same dialog.
- **An undoable removal.** A removal that Ctrl or Cmd+Z takes back asks in place, because it is a step of the form's history, which the Form workspace's Undo always reaches, and which a designer's Undo reaches while it is the newest thing done in that designer, on whichever document or view (ADR 0180, decisions 7 to 9, which also says where it is not: a step made in another workspace or while the other designer was on the page). It asks with one warning note where the action was pressed (`.note.confirm[data-tone="warning"]`): its words, then Cancel first and the action second, the action `danger` when it deletes, focus on Cancel. It is used for removing a language and making one the default (Languages), replacing the form's contents from a data sample or schema (the Data workspace's Import), removing a test (Tests) and deleting a journey or a PDF layout (the document's menu on the bar, and the phone's menu drawer).
- **A small undoable edit.** An edit that is undone as easily as it is done asks nothing: removing a rule (Logic), clearing a component's print settings and resetting a running-header slot (Print), removing a header or footer part, removing an option row.

### 3. Dialogs keep to the builder's box

Every prompt and editor the builder raises (unapplied edits, a delete, a file confirm, the command palette, the keyed-text editors, the Data and Languages imports, the PDF preview) is a `<dialog>` opened with `showModal()`: the top layer is the one place nothing on the page can stack above or clip, and a modal dialog cannot be clicked past. A builder dialog is opened through `showBuilderModal()` and nowhere else, which a test holds.

The top layer is laid out against the window, so an embedded builder would centre its prompt in the window, away from the field being edited, and dim a page that is not its own. The dialog therefore stays modal and is told where the builder is. `modal-place.ts` writes the visible part of the shell's box onto the dialog as `--db-modal-inset` (its four insets from the window's edges), `--db-modal-w` and `--db-modal-h`; every dialog's styles place and size by them, and the backdrop is clipped to the same box, so only the builder dims. The box is followed while the dialog is open, because the page still scrolls under a modal dialog. When too little of the builder is in view to hold a dialog, the window is the box, as it is for a builder that fills the window.

The page outside the builder is not dimmed but stays inert until the prompt is answered: that is what keeps it a prompt.

### 4. Leaving the page

Unsaved work does not survive a reload, a followed link or a closed tab, and only the browser can stop a page from going. While the form is `dirty`, or an edit is held in a panel (`hasUnsavedChanges()`), `<datum-form-builder>` cancels `beforeunload`, so the browser asks in its own words. `leave-guard="off"` turns that off for a page that keeps the work some other way; it is read when the page is about to go, so it can change at any time.

A page that takes the builder away without unloading (a route change) is not seen by the browser: that is `requestLeave(run)`, the same guard the builder's own departures go through (ADR 0111, decision 13).

## Consequences

- A new bar of tools, question or dialog takes its behaviour from these four rules instead of choosing its own.
- An embedded builder asks its questions inside its own box and leaves the page around it as it was.
- The attribute and method names are in [the builder guide](../reference/builder.md) (The bar, "Leaving the page") and [the attribute reference](../reference/attributes.md) (`leave-guard`).
