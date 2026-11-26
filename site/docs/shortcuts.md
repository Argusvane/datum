# Keyboard shortcuts

Everything in the builder can be done from the keyboard. This page lists the keys by area. **Ctrl** means Cmd on a Mac. Keys marked "on the canvas" act only while the canvas page has focus (Tab to it, or click the empty sheet) and the canvas is in edit mode, not in Try it or Preview.

Some of these keys are named in tooltips (Undo, Redo, Search commands, Move to… and the zoom buttons) and the canvas lists its own for screen readers. This page gathers them all.

## Anywhere in the builder

| Keys | Does |
|---|---|
| Ctrl+K | Opens the command palette. Without the `palette` feature the key is left to the page. |
| Ctrl+S | Saves, when the page has given the builder a Save. Without one the key is left to the page. See [Saving](/builder-element#saving). |
| Ctrl+Z | Undoes the last change on the side you are working on (the form, a PDF layout or a journey). Works on the canvas and in the outline. |
| Ctrl+Shift+Z | Redoes it. |
| Escape | Closes the menu, card, popover or dialog that has focus and returns focus to the control that opened it. On a phone it closes the open sheet or drawer. |

- Ctrl+K and Ctrl+S ignore the key when Alt or Shift is also held.
- Redo is Ctrl+Shift+Z in the builder itself.
- Ctrl+Y redoes only inside the formula box, the test editor and the JSON box, which keep a history of their own, together with Ctrl+Z and Ctrl+Shift+Z.
- In a field of the form you are trying, undo is the field's own and never the builder's.

## The bar

| Where | Keys | Does |
|---|---|---|
| Workspace tabs | Tab | The tabs are one Tab stop. |
| | Left, Right | Move to the previous or next tab, wrapping at the ends. |
| | Home, End | Move to the first or last tab. |
| | Enter, Space | Open the workspace in focus. |
| Menu (the ⋮ button) | Down, Up | Open the menu with the first or last item in focus. |
| | Down, Up, Home, End (menu open) | Move between items, wrapping. |
| | Escape | Close the menu and return to its button. |
| | Tab | Close the menu. |
| Documents dropdown (layouts, journeys) | Down, Up, Home, End | Move between its items, wrapping. |
| | Escape | Close it and return to its label. |
| Name box while renaming a document | Enter | Keep the name. |
| | Escape | Cancel the rename. |
| Folded actions (the More card in a designer's bar) | Escape | Close the card. |

## The strip and its panels

| Where | Keys | Does |
|---|---|---|
| Strip | Down, Up | Move between the panel buttons, wrapping. The page's own strip items are in the same walk. |
| | Enter, Space | Open or close the panel. |
| Component rail (Form workspace) | Down, Up, Home, End | Move between the common component buttons, wrapping. |
| | Enter, Space | Add that component after the selection. |
| Components panel | Down, Up, Home, End | Move between components and group headings, wrapping. The list is one Tab stop. |
| | Enter, Space | On a component, add it. On a heading, open or close the group. |
| Outline | Ctrl+Z, Ctrl+Shift+Z | Undo and redo. |
| Header & footer panel | Enter | Apply the edit in the panel (not from a multi-line box or a button). |
| | Escape | Discard it. Escape closes the ⋯ menu first when it is open. |
| Tests panel | Down, Up | On the Add step button, open its menu with the first or last item in focus. |
| | Down, Up, Home, End (menu open) | Move between items, wrapping. |
| | Escape | Close the Add step menu, or the Assert popover, and return to its button. |

## The command palette

Open it with Ctrl+K or the search button on the bar.

| Keys | Does |
|---|---|
| Type | Filters the commands as you type. |
| Down, Up | Move through the matches. |
| Home, End | In the box, move to the first or last command that can run. |
| Enter | Runs the command in focus. |
| Escape | Closes the palette. |
| Tab | Keeps focus in the box. The list is reached with the arrows. |

## The canvas

These keys work with focus on the canvas page. Right and Left swap in a right-to-left page.

| Keys | Does |
|---|---|
| Down, Up | Select the next or previous component, in reading order. |
| Right | Select the first component inside the selected container. |
| Left | Select the container the selected component sits in. |
| Home, End | Select the first or last component of the form. |
| Alt+Up, Alt+Down | Move the selected component up or down among its siblings. |
| M | Start Move mode on the selected component. |
| Delete, Backspace | Delete the selected component, after a confirmation. |
| Enter | Move focus to the inspector to edit the selected component's settings. |
| Escape | Clear the selection. |
| + or = | Zoom in, by a quarter of the current size at a time, up to 200%. |
| - or _ | Zoom out, down to 25%. |
| 0 | Fit the whole form and centre it. |
| Shift+arrow | Pan the sheet by 48 pixels. |

Plus, minus and 0 are ignored when Ctrl, Cmd or Alt is held, so the browser's own zoom keys keep working. A screen reader says the selected component's position (for example "Country, select, 4 of 12") as the selection moves.

### Move mode

Press M with a component selected. Move mode takes every key until it ends, and nothing changes until you press Enter.

| Keys | Does |
|---|---|
| Down, Right | Go to the next place the component may go. |
| Up, Left | Go to the previous place. |
| Home, End | Go to the first or last place. |
| Enter | Move the component to the place shown, and end Move mode. |
| Escape | Cancel and leave the component where it was. |
| Tab | Cancel, and move focus on as Tab does. |

- The place is shown as the drag's insertion marker, in a tab or step that is opened to show it, and a live region says where it is, such as "Contact, position 2 of 5".
- A component that has nowhere else to go says so and Move mode does not start.
- The same moves are in the Move to… button on the selection bar, which opens a dialog instead.

### The selection bar

The bar that appears with a selection (Edit, Move up, Move down, Move to…, Duplicate, Add logic, Delete) is one Tab stop.

| Keys | Does |
|---|---|
| Left, Right | Move between its buttons, wrapping. |
| Home, End | Move to the first or last. |
| Escape | Return focus to the canvas. |

The width and zoom buttons that fold into a pop-over on a narrow canvas close on Escape, with focus back on the button that opened them.

## The inspector

| Keys | Does |
|---|---|
| Enter | Applies the edits waiting in the panel. Not in a multi-line box (a text area, or the JSON box), and not on a section heading, where Enter opens or closes the section. |
| Enter in the Label box | Applies, and moves on to the next control. |
| Escape | Discards the edits waiting in the panel. Not in a multi-line box. Escape closes the ⋯ menu first when it is open. |
| Escape over a prompt | Answers it with Keep editing, never with Discard. |
| Enter in an options editor's add row | Adds the option. |
| Escape in the options editor | Closes it, asking first when it holds changes. |

See [Building a form](/building-a-form#the-inspector) for what Apply and Discard do and how problems are shown.

## Formula and test boxes

| Where | Keys | Does |
|---|---|---|
| Formula box, one line | Enter | Applies the formula. |
| Formula box, several lines | Enter | Starts a new line, indented under `then` and `else`. Leaving the box applies the formula. |
| Formula box, plain-text fallback | Ctrl+Enter | Applies, in a box of several lines. |
| Formula box | Tab | Accepts the highlighted suggestion. |
| Test editor | Enter | Starts a new line at the same indent, and two spaces under a `test` header. |
| | Ctrl+Enter | Applies the test. |
| | Tab | Accepts the highlighted suggestion. |
| | Ctrl+Space | Opens suggestions. At the start of a line they wait for a letter or this key. |
| Both | Ctrl+Z, Ctrl+Shift+Z, Ctrl+Y | Undo and redo within the box. |

## Logic, Data and Languages

| Where | Keys | Does |
|---|---|---|
| Logic | Escape | Closes the New menu or the Run menu and returns to its button. On a phone, where the rule editor is a sheet, it closes the sheet. |
| Data | Escape | In the Import dialog, first puts away the Replace confirmation, then closes the dialog. On a phone, where the row editor is a sheet, it closes the sheet. |
| Languages | Enter in the add-language box | Adds the language. |
| | Enter in the search box | Applies the search at once. |
| | Enter in a grid cell | In the one-language view, moves to the next text that needs translating. |
| | Enter in the rename box | Renames the language. |
| | Escape | Closes a language's menu, puts away the Remove or Make default confirmation, or cancels a rename. |
| Export and Import dialogs | Escape | Close the dialog. |

## Journeys

| Where | Keys | Does |
|---|---|---|
| Journey map | Tab | The map is one Tab stop. Focus is not selection, so walking it never raises the unsaved-edits prompt. |
| | Down, Right, Up, Left | Walk the items in reading order: a step, its routes in the order they are tried, its ignored routes, the next step. |
| | Alt+Down, Alt+Right | Follow a route to where it goes. |
| | Alt+Up, Alt+Left | Go back to where the item was followed from. |
| | Home, End | First and last item. |
| | Enter | Select the item. On a step, also open it in the Step view. |
| | Space | Select the item. |
| | Shift+Enter | Open the step in the Step view. |
| | Delete, Backspace | Delete the selected step. Not the only step. |
| | + or =, - or _, 0 | Zoom in, zoom out, fit. Ignored with Ctrl or Cmd. |
| | Escape | Clear the highlight. |
| Map's bar and the selected step's bar | Left, Right, Home, End | Move between its buttons, wrapping. Each bar is one Tab stop. |
| Selected step's bar | Escape | Return to the step's card. |
| New journey popover | Enter in the name box | Makes the journey with one empty step. |
| | Escape | Closes the popover and returns to the button. |
| Step view | Ctrl+Z, Ctrl+Shift+Z | Undo and redo through one history over the form and the journey. |

## PDF

| Where | Keys | Does |
|---|---|---|
| New layout popover | Enter in the name box | Confirms the name. |
| | Escape | Closes the popover and returns to the button. |
| Page of a template PDF, with an area selected | Arrow keys | Move the area by 1 point. |
| | Shift+arrow | Move it by 10 points. |
| | Delete, Backspace | Remove the area. |
| | Escape | Deselect it. |

## Commands of your own

A page that hosts the builder can add commands to the palette with `registerCommands()`, and a command can carry a `shortcut` label, which the palette shows but never binds. See [Customising the builder](/customising-the-builder#the-command-palette).
